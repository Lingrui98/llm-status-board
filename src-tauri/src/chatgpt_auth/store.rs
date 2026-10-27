use super::oauth::{self, Session};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio::sync::Mutex;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRef {
    pub auth_id: String,
    pub account_id: Option<String>,
}

pub(crate) struct Credentials {
    pub token: String,
    pub account_id: Option<String>,
}

struct Cached {
    session: Session,
    dirty: bool,
}

pub(super) struct Store {
    pub root: PathBuf,
    // Serializes rotation/logout. A concurrent 401 must not spend the same refresh token twice.
    sessions: Mutex<HashMap<String, Cached>>,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("ChatGPT 登录引用无效，请重新登录".into());
        }
        Ok(self.root.join(format!("{id}.json")))
    }

    pub async fn save_new(&self, session: Session) -> Result<SessionRef, String> {
        let id = oauth::random_id()?;
        let reference = SessionRef {
            auth_id: id.clone(),
            account_id: session.account_id.clone(),
        };
        let mut sessions = self.sessions.lock().await;
        write_private(&self.path(&id)?, &session)?;
        sessions.insert(
            id,
            Cached {
                session,
                dirty: false,
            },
        );
        Ok(reference)
    }

    pub async fn credentials(
        &self,
        client: &reqwest::Client,
        endpoint: &str,
        id: &str,
        rejected: Option<&str>,
    ) -> Result<Credentials, String> {
        let path = self.path(id)?;
        let mut sessions = self.sessions.lock().await;
        if !sessions.contains_key(id) {
            let mut data = Vec::new();
            fs::File::open(&path)
                .and_then(|f| f.take(1_048_577).read_to_end(&mut data))
                .map_err(|_| {
                    "找不到此设备的 ChatGPT 登录，请点击「使用 ChatGPT 登录」".to_string()
                })?;
            if data.len() > 1_048_576 {
                return Err("本机 ChatGPT 凭据格式无效，请重新登录".into());
            }
            let session: Session = serde_json::from_slice(&data)
                .map_err(|_| "本机 ChatGPT 凭据格式无效，请重新登录".to_string())?;
            sessions.insert(
                id.into(),
                Cached {
                    session,
                    dirty: false,
                },
            );
        }
        let cached = sessions.get_mut(id).unwrap();
        if cached.dirty {
            write_private(&path, &cached.session)?;
            cached.dirty = false;
        }
        let force = rejected.is_some_and(|old| old == cached.session.access_token);
        if force || cached.session.expires_at <= chrono::Utc::now().timestamp() + 60 {
            let updated = oauth::refresh(client, endpoint, &cached.session).await?;
            // Retain rotated tokens in memory if disk is temporarily unavailable; retry the
            // write on the next query before making any further token exchange.
            cached.session = updated;
            cached.dirty = true;
            write_private(&path, &cached.session)?;
            cached.dirty = false;
        }
        Ok(Credentials {
            token: cached.session.access_token.clone(),
            account_id: cached.session.account_id.clone(),
        })
    }

    pub async fn forget(&self, id: &str) -> Result<(), String> {
        let path = self.path(id)?;
        let mut sessions = self.sessions.lock().await;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("删除本机 ChatGPT 凭据失败".into()),
        }
        sessions.remove(id);
        Ok(())
    }
}

fn write_private(path: &Path, session: &Session) -> Result<(), String> {
    let root = path.parent().ok_or("ChatGPT 凭据目录无效")?;
    let mut dir = fs::DirBuilder::new();
    dir.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dir.mode(0o700);
    }
    dir.create(root)
        .map_err(|_| "创建 ChatGPT 凭据目录失败".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "设置 ChatGPT 凭据目录权限失败".to_string())?;
    }
    let temp = root.join(format!(".{}.tmp", oauth::random_id()?));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|_| ())?;
        let data = serde_json::to_vec(session).map_err(|_| ())?;
        file.write_all(&data).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| ())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|_| "保存 ChatGPT 凭据失败，请检查本机磁盘和目录权限后重试".into())
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
