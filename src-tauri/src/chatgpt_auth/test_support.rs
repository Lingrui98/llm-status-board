use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};

pub(super) fn jwt(value: Value) -> String {
    format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(value.to_string())
    )
}

pub(super) fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

pub(super) struct Server {
    pub url: String,
    thread: thread::JoinHandle<Vec<String>>,
}

impl Server {
    pub fn new(responses: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let thread = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(e) => panic!("mock accept failed: {e}"),
                    }
                };
                // macOS inherits the listener's nonblocking flag.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut data = Vec::new();
                loop {
                    let mut chunk = [0; 1024];
                    let count = stream.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&chunk[..count]);
                    assert!(data.len() < 1_048_576);
                    if let Some(index) = data.windows(4).position(|s| s == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&data[..index]);
                        let length = header
                            .lines()
                            .filter_map(|l| l.split_once(':'))
                            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                            .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if data.len() >= index + 4 + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(data).unwrap());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        Self { url, thread }
    }

    pub fn json(status: u16, body: Value) -> Self {
        let body = body.to_string();
        Self::new(vec![format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())])
    }

    pub fn finish(self) -> Vec<String> {
        self.thread.join().unwrap()
    }
}
