//! Read-only API Platform reporting using the configured organization Admin Key.
use crate::http;
use crate::types::{AccountConfig, AccountInfo, Money, OpenAiBilling, UsagePoint};
use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use url::Url;

const ORIGIN: &str = "https://api.openai.com";
const MAX_PAGES: usize = 32;
const MAX_DAYS: i64 = 90;
const SUMMARY_DAYS: u64 = 30;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionItem {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    days: Vec<Day>,
    models: Vec<Model>,
    currency: Option<String>,
    costs_error: Option<String>,
    usage_error: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Day {
    date: String,
    cost: Option<f64>,
    month_to_date: Option<f64>,
    #[serde(flatten)]
    usage: Option<Usage>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    cached_input_tokens: Option<u64>,
    cache_write_tokens: Option<u64>,
    requests: u64,
}

impl Usage {
    fn add(&mut self, row: &Completion, first: bool) {
        self.input_tokens = self.input_tokens.saturating_add(row.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(row.output_tokens);
        self.requests = self.requests.saturating_add(row.num_model_requests);
        self.cached_input_tokens =
            sum_optional(self.cached_input_tokens, row.input_cached_tokens, first);
        self.cache_write_tokens =
            sum_optional(self.cache_write_tokens, row.input_cache_write_tokens, first);
    }

    fn into_point(self) -> UsagePoint {
        UsagePoint {
            requests: Some(i64::try_from(self.requests).unwrap_or(i64::MAX)),
            input_tokens: Some(self.input_tokens as f64),
            output_tokens: Some(self.output_tokens as f64),
            tokens: Some(self.input_tokens.saturating_add(self.output_tokens) as f64),
            ..Default::default()
        }
    }
}

fn sum_optional(total: Option<u64>, value: Option<u64>, first: bool) -> Option<u64> {
    if first {
        value
    } else {
        total.zip(value).map(|(a, b)| a.saturating_add(b))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    name: String,
    #[serde(flatten)]
    usage: Usage,
}

#[derive(Deserialize)]
struct Page<T> {
    data: Vec<T>,
    has_more: bool,
    next_page: Option<String>,
}

#[derive(Deserialize)]
struct Listed<T> {
    data: Vec<T>,
    has_more: bool,
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct ListedItem {
    id: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct Bucket<T> {
    start_time: i64,
    results: Vec<T>,
}

#[derive(Deserialize)]
struct Cost {
    amount: CostAmount,
}

#[derive(Deserialize)]
struct CostAmount {
    currency: String,
    value: f64,
}

#[derive(Deserialize)]
struct Completion {
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    input_cached_tokens: Option<u64>,
    input_cache_write_tokens: Option<u64>,
    num_model_requests: u64,
}

#[derive(Deserialize)]
struct SpendLimit {
    threshold_amount: u64,
    currency: String,
    interval: String,
    enforcement: Enforcement,
}

#[derive(Deserialize)]
struct Enforcement {
    status: String,
}

struct Costs {
    days: BTreeMap<NaiveDate, f64>,
    currency: String,
}

#[derive(Default)]
struct CompletionStats {
    days: BTreeMap<NaiveDate, Usage>,
    models: Vec<Model>,
}

#[derive(Default)]
struct Filter<'a> {
    project: Option<&'a str>,
    key: Option<&'a str>,
}

struct Api<'a> {
    client: &'a reqwest::Client,
    key: &'a str,
    origin: &'a str,
}

impl<'a> Api<'a> {
    fn new(client: &'a reqwest::Client, account: &'a AccountConfig) -> Result<Self, String> {
        let key = account.api_key.trim();
        if key.is_empty() {
            return Err("请填写 OpenAI API Platform Admin Key".into());
        }
        if !account.base().is_empty() && account.base() != ORIGIN {
            return Err(
                "OpenAI Admin Key 只可用于 https://api.openai.com。代理请在通用设置配置。".into(),
            );
        }
        Ok(Self {
            client,
            key,
            origin: ORIGIN,
        })
    }

    fn endpoint(&self, path: &str) -> Url {
        Url::parse(&format!("{}/v1/organization/{path}", self.origin)).expect("fixed API URL")
    }

    async fn get<T: DeserializeOwned>(&self, url: Url) -> Result<T, String> {
        let response = self
            .client
            .get(url)
            .bearer_auth(self.key)
            .send()
            .await
            .map_err(http::describe_request_error)?;
        let status = response.status();
        if !status.is_success() {
            let hint = match status.as_u16() {
                401 | 403 => "，请检查 Admin Key 及此接口的读取权限",
                429 => "，查询过于频繁，请稍后重试",
                _ => "",
            };
            return Err(format!("HTTP {status}{hint}"));
        }
        response
            .json()
            .await
            .map_err(|_| "OpenAI 返回了无法读取的数据".into())
    }

    fn series_url(
        &self,
        path: &str,
        from: NaiveDate,
        end: i64,
        limit: &str,
        filter: &Filter<'_>,
    ) -> Url {
        let mut url = self.endpoint(path);
        let mut query = url.query_pairs_mut();
        query
            .append_pair("start_time", &midnight(from).to_string())
            .append_pair("end_time", &end.to_string())
            .append_pair("bucket_width", "1d")
            .append_pair("limit", limit);
        if let Some(project) = filter.project {
            query.append_pair("project_ids", project);
        }
        if let Some(key) = filter.key {
            query.append_pair("api_key_ids", key);
        }
        drop(query);
        url
    }

    async fn buckets<T: DeserializeOwned>(&self, url: Url) -> Result<Vec<Bucket<T>>, String> {
        let mut output = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut requested = url.clone();
            if let Some(page) = &cursor {
                requested.query_pairs_mut().append_pair("page", page);
            }
            let page: Page<Bucket<T>> = self.get(requested).await?;
            output.extend(page.data);
            if !page.has_more {
                return Ok(output);
            }
            cursor = Some(next_cursor(page.next_page, &mut seen)?);
        }
        Err("OpenAI 数据分页过多，请缩短查询时间".into())
    }

    async fn costs(&self, from: NaiveDate, end: i64, filter: &Filter<'_>) -> Result<Costs, String> {
        let buckets = self
            .buckets::<Cost>(self.series_url("costs", from, end, "180", filter))
            .await?;
        let mut days = BTreeMap::new();
        let mut currency: Option<String> = None;
        for bucket in buckets {
            let day = bucket_date(bucket.start_time, from, end)?;
            let daily = days.entry(day).or_insert(0.0);
            for row in bucket.results {
                let unit = row.amount.currency.to_ascii_uppercase();
                if unit.len() != 3
                    || !unit.bytes().all(|b| b.is_ascii_alphabetic())
                    || currency.as_ref().is_some_and(|current| *current != unit)
                {
                    return Err("OpenAI 费用币种不一致，无法合并".into());
                }
                currency.get_or_insert(unit);
                *daily += row.amount.value;
                if !daily.is_finite() {
                    return Err("OpenAI 费用金额无效".into());
                }
            }
        }
        Ok(Costs {
            days,
            currency: currency.unwrap_or_else(|| "USD".into()),
        })
    }

    async fn completions(
        &self,
        from: NaiveDate,
        end: i64,
        filter: &Filter<'_>,
    ) -> Result<CompletionStats, String> {
        let mut url = self.series_url("usage/completions", from, end, "31", filter);
        url.query_pairs_mut().append_pair("group_by", "model");
        let buckets = self.buckets::<Completion>(url).await?;
        let mut days = BTreeMap::new();
        let mut models = BTreeMap::new();
        for bucket in buckets {
            let day = bucket_date(bucket.start_time, from, end)?;
            let day_usage = days.entry(day).or_default();
            for row in bucket.results {
                let name = row
                    .model
                    .as_deref()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("未归类模型");
                add_usage(models.entry(name.to_owned()).or_default(), &row);
                add_usage(day_usage, &row);
            }
        }
        Ok(CompletionStats {
            days: days
                .into_iter()
                .map(|(day, (usage, _))| (day, usage))
                .collect(),
            models: models
                .into_iter()
                .map(|(name, (usage, _))| Model { name, usage })
                .collect(),
        })
    }

    async fn list(&self, project: Option<&str>) -> Result<Vec<OptionItem>, String> {
        let mut url = self.endpoint(
            &project.map_or_else(|| "projects".into(), |id| format!("projects/{id}/api_keys")),
        );
        url.query_pairs_mut().append_pair("limit", "100");
        if project.is_none() {
            url.query_pairs_mut()
                .append_pair("include_archived", "true");
        }
        let mut items = Vec::new();
        let mut seen = HashSet::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut requested = url.clone();
            if let Some(after) = &cursor {
                requested.query_pairs_mut().append_pair("after", after);
            }
            let page: Listed<ListedItem> = self.get(requested).await?;
            items.extend(page.data.into_iter().map(|item| {
                OptionItem {
                    name: item
                        .name
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| item.id.clone()),
                    id: item.id,
                }
            }));
            if !page.has_more {
                return Ok(items);
            }
            cursor = Some(next_cursor(page.last_id, &mut seen)?);
        }
        Err("OpenAI 项目或 Key 列表分页过多".into())
    }
}

fn add_usage(total: &mut (Usage, bool), row: &Completion) {
    // Map entries start with a false flag, so no observed rows have been added yet.
    total.0.add(row, !total.1);
    total.1 = true;
}

fn next_cursor(value: Option<String>, seen: &mut HashSet<String>) -> Result<String, String> {
    value
        .filter(|cursor| !cursor.is_empty() && seen.insert(cursor.clone()))
        .ok_or_else(|| "OpenAI 分页游标缺失或重复，本次未使用不完整数据".into())
}

fn midnight(date: NaiveDate) -> i64 {
    date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()
}

fn month_start(date: NaiveDate) -> NaiveDate {
    date.with_day(1).expect("valid first day of the month")
}

fn bucket_date(ts: i64, from: NaiveDate, end: i64) -> Result<NaiveDate, String> {
    DateTime::from_timestamp(ts, 0)
        .filter(|dt| dt.date_naive() >= from && ts < end)
        .map(|dt| dt.date_naive())
        .ok_or_else(|| "OpenAI 用量日期超出查询范围".into())
}

fn validate_id(value: Option<&str>) -> Result<Option<&str>, String> {
    match value {
        Some(id)
            if id.is_empty()
                || id.len() > 160
                || !id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) =>
        {
            Err("OpenAI 项目或 Key ID 格式无效".into())
        }
        _ => Ok(value),
    }
}

pub async fn fetch(
    client: &reqwest::Client,
    account: &AccountConfig,
) -> Result<AccountInfo, String> {
    let api = Api::new(client, account)?;
    summary(&api, Utc::now()).await
}

async fn summary(api: &Api<'_>, now: DateTime<Utc>) -> Result<AccountInfo, String> {
    let today = now.date_naive();
    let month = month_start(today);
    let start = today.checked_sub_days(Days::new(SUMMARY_DAYS - 1)).unwrap();
    let filter = Filter::default();
    let end = now.timestamp().max(midnight(today) + 1);
    let (costs, usage, limit) = tokio::join!(
        api.costs(start.min(month), end, &filter),
        api.completions(start, end, &filter),
        api.get::<SpendLimit>(api.endpoint("spend_limit")),
    );
    let (used, costs_error, currency, costs) = match costs.and_then(|costs| {
        let amount = costs.days.range(month..).map(|(_, cost)| cost).sum::<f64>();
        if !amount.is_finite() {
            return Err("OpenAI 本月花费金额无效".into());
        }
        Ok((
            Money {
                amount,
                currency: costs.currency,
            },
            costs.days,
        ))
    }) {
        Ok((used, costs)) => (Some(used.clone()), None, Some(used.currency), costs),
        Err(error) => (None, Some(error), None, BTreeMap::new()),
    };
    let (usage, usage_error) = match usage {
        Ok(usage) => (usage, None),
        Err(error) => (CompletionStats::default(), Some(error)),
    };
    if let (Some(costs_error), Some(usage_error)) = (&costs_error, &usage_error) {
        return Err(format!(
            "OpenAI 花费查询失败：{costs_error}；模型用量查询失败：{usage_error}"
        ));
    }

    let mut billing = match limit {
        Ok(limit)
            if limit.interval == "month"
                && limit.currency.eq_ignore_ascii_case("USD")
                && matches!(limit.enforcement.status.as_str(), "inactive" | "enforcing") =>
        {
            OpenAiBilling {
                spend_limit: (limit.threshold_amount > 0).then(|| Money {
                    amount: limit.threshold_amount as f64 / 100.0,
                    currency: "USD".into(),
                }),
                enforcing: limit.enforcement.status == "enforcing",
                limit_error: None,
                costs_error: None,
                usage_error: None,
            }
        }
        other => OpenAiBilling {
            spend_limit: None,
            enforcing: false,
            limit_error: Some(
                other
                    .err()
                    .unwrap_or_else(|| "OpenAI 返回了无法识别的上限".into()),
            ),
            costs_error: None,
            usage_error: None,
        },
    };
    billing.costs_error = costs_error;
    billing.usage_error = usage_error;

    let mut days = BTreeMap::new();
    for (date, usage) in usage.days {
        let mut point = usage.into_point();
        point.date = Some(date.to_string());
        point.cost_unit = currency.clone();
        days.insert(date, point);
    }
    for (date, cost) in costs {
        let point = days.entry(date).or_default();
        point.date.get_or_insert_with(|| date.to_string());
        point.cost = Some(cost);
        point.cost_unit = currency.clone();
    }
    Ok(AccountInfo {
        used,
        daily_usage: days.into_values().collect(),
        model_usage: usage
            .models
            .into_iter()
            .map(|model| UsagePoint {
                model: Some(model.name),
                ..model.usage.into_point()
            })
            .collect(),
        open_ai_billing: Some(billing),
        fetched_at: now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        ..Default::default()
    })
}

pub async fn filters(
    client: &reqwest::Client,
    account: &AccountConfig,
    project: Option<&str>,
) -> Result<Vec<OptionItem>, String> {
    Api::new(client, account)?.list(validate_id(project)?).await
}

pub async fn report(
    client: &reqwest::Client,
    account: &AccountConfig,
    start: &str,
    end: &str,
    project: Option<&str>,
    key: Option<&str>,
) -> Result<Report, String> {
    let now = Utc::now();
    let (from, to, end) = report_range(start, end, now)?;
    let filter = Filter {
        project: validate_id(project)?,
        key: validate_id(key)?,
    };
    let api = Api::new(client, account)?;
    let (costs, usage) = tokio::join!(
        api.costs(month_start(from), end, &filter),
        api.completions(from, end, &filter),
    );
    Ok(assemble_report(from, to, costs, usage))
}

fn report_range(
    start: &str,
    end: &str,
    now: DateTime<Utc>,
) -> Result<(NaiveDate, NaiveDate, i64), String> {
    let parse = |date| {
        NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "请选择有效的 UTC 日期".to_string())
    };
    let from = parse(start)?;
    let to = parse(end)?;
    if from > to
        || to > now.date_naive()
        || (to - from).num_days() >= MAX_DAYS
        || from < now.date_naive().checked_sub_days(Days::new(366)).unwrap()
    {
        return Err("请选择近一年内、最长 90 天且不含未来日期的区间".into());
    }
    let end =
        midnight(to.succ_opt().expect("next day")).min(now.timestamp().max(midnight(from) + 1));
    Ok((from, to, end))
}

fn assemble_report(
    from: NaiveDate,
    to: NaiveDate,
    costs: Result<Costs, String>,
    usage: Result<CompletionStats, String>,
) -> Report {
    let (costs, costs_error) = match costs {
        Ok(value) => (Some(value), None),
        Err(error) => (None, Some(error)),
    };
    let (mut usage, usage_error) = match usage {
        Ok(value) => (value, None),
        Err(error) => (CompletionStats::default(), Some(error)),
    };
    let mut days = Vec::new();
    let mut month_total = 0.0;
    for date in month_start(from).iter_days().take_while(|date| *date <= to) {
        if date.day() == 1 {
            month_total = 0.0;
        }
        let cost = costs
            .as_ref()
            .and_then(|costs| costs.days.get(&date))
            .copied();
        if let Some(cost) = cost {
            month_total += cost;
        }
        if date >= from {
            days.push(Day {
                date: date.to_string(),
                cost,
                month_to_date: cost
                    .map(|_| month_total)
                    .filter(|amount| amount.is_finite()),
                usage: usage.days.remove(&date),
            });
        }
    }
    usage.models.sort_by_key(|m| {
        std::cmp::Reverse(m.usage.input_tokens.saturating_add(m.usage.output_tokens))
    });
    usage.models.truncate(8);
    Report {
        days,
        models: usage.models,
        currency: costs.map(|costs| costs.currency),
        costs_error,
        usage_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn page(date: &str, rows: Vec<Value>, next: Option<&str>) -> Value {
        json!({"object":"page","has_more":next.is_some(),"next_page":next,
            "data":[{"start_time":midnight(day(date)),"results":rows}]})
    }

    fn cost(amount: f64) -> Value {
        json!({"object":"organization.costs.result", "line_item":"fixture line", "amount":{"currency":"usd","value":amount}})
    }

    fn completion(model: &str, input: u64, output: u64, requests: u64) -> Value {
        json!({"model":model,"input_tokens":input,"output_tokens":output,"num_model_requests":requests})
    }

    fn mock_server(
        requests: usize,
        respond: impl Fn(Url) -> (u16, Value) + Send + 'static,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = origin.clone();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(8);
            for _ in 0..requests {
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("Mock OpenAI request did not arrive: {error}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(line.starts_with("GET "));
                let target = line.split_whitespace().nth(1).unwrap();
                let url = Url::parse(&format!("{base}{target}")).unwrap();
                let mut authenticated = false;
                loop {
                    line.clear();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    authenticated |= line
                        .trim()
                        .eq_ignore_ascii_case("Authorization: Bearer test-admin-key");
                }
                assert!(authenticated);
                let (status, body) = respond(url);
                let body = body.to_string();
                write!(stream, "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (origin, handle)
    }

    #[tokio::test]
    async fn summary_combines_unfiltered_usage_and_cross_month_costs() {
        let (origin, server) = mock_server(5, |url| {
            let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
            assert!(!params.contains_key("project_ids") && !params.contains_key("api_key_ids"));
            match url.path() {
                "/v1/organization/costs" => {
                    assert_eq!(
                        params["start_time"],
                        midnight(day("2026-10-20")).to_string()
                    );
                    if let Some(cursor) = params.get("page") {
                        assert_eq!(cursor, "next+/&page");
                        (200, page("2026-11-18", vec![cost(2.5)], None))
                    } else {
                        let mut payload = page(
                            "2026-11-01",
                            vec![cost(9.0), cost(1.0)],
                            Some("next+/&page"),
                        );
                        payload["data"].as_array_mut().unwrap().push(
                            json!({"start_time":midnight(day("2026-10-20")),"results":[cost(99.0)]}),
                        );
                        (200, payload)
                    }
                }
                "/v1/organization/usage/completions" => {
                    assert_eq!(params["group_by"], "model");
                    assert_eq!(
                        params["start_time"],
                        midnight(day("2026-10-20")).to_string()
                    );
                    if let Some(cursor) = params.get("page") {
                        assert_eq!(cursor, "usage-next");
                        (
                            200,
                            page(
                                "2026-11-18",
                                vec![completion("most-requests", 1, 2, 15)],
                                None,
                            ),
                        )
                    } else {
                        let rows = (0..8)
                            .map(|index| completion(&format!("model-{index}"), 20, 5, 1))
                            .collect();
                        (200, page("2026-11-17", rows, Some("usage-next")))
                    }
                }
                "/v1/organization/spend_limit" => (403, json!({"error":"scope required"})),
                _ => panic!("Unexpected endpoint: {}", url.path()),
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let api = Api {
            client: &client,
            key: "test-admin-key",
            origin: &origin,
        };
        let result = summary(&api, "2026-11-18T12:00:00Z".parse().unwrap())
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(result.used.unwrap().amount, 12.5);
        assert!(result.balance.is_none() && result.total.is_none());
        assert_eq!(result.daily_usage[0].cost, Some(99.0));
        assert_eq!(result.daily_usage[0].requests, None);
        assert_eq!(result.daily_usage[2].cost, None);
        assert_eq!(result.daily_usage[2].requests, Some(8));
        let today = result.daily_usage.last().unwrap();
        assert_eq!(today.cost, Some(2.5));
        assert_eq!(today.cost_unit.as_deref(), Some("USD"));
        assert_eq!(today.requests, Some(15));
        assert_eq!(today.tokens, Some(3.0));
        assert_eq!(result.model_usage.len(), 9);
        assert!(result
            .model_usage
            .iter()
            .any(|model| model.requests == Some(15)));
        let billing = result.open_ai_billing.unwrap();
        assert!(billing.spend_limit.is_none());
        assert!(billing.limit_error.unwrap().contains("403"));
    }

    #[tokio::test]
    async fn summary_preserves_the_available_metric_on_partial_failure() {
        for failed_costs in [true, false] {
            let (origin, server) = mock_server(3, move |url| match url.path() {
                "/v1/organization/costs" if !failed_costs => {
                    (200, page("2026-11-18", vec![cost(3.5)], None))
                }
                "/v1/organization/usage/completions" if failed_costs => (
                    200,
                    page("2026-11-18", vec![completion("gpt-a", 1, 2, 3)], None),
                ),
                _ => (403, json!({"error":"scope required"})),
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let api = Api {
                client: &client,
                key: "test-admin-key",
                origin: &origin,
            };
            let result = summary(&api, "2026-11-18T12:00:00Z".parse().unwrap())
                .await
                .unwrap();
            server.join().unwrap();

            assert_eq!(
                result.used.map(|used| used.amount),
                (!failed_costs).then_some(3.5)
            );
            assert_eq!(result.daily_usage[0].cost, (!failed_costs).then_some(3.5));
            assert_eq!(result.daily_usage[0].requests, failed_costs.then_some(3));
            let billing = result.open_ai_billing.unwrap();
            assert_eq!(billing.costs_error.is_some(), failed_costs);
            assert_eq!(billing.usage_error.is_some(), !failed_costs);
        }
    }

    #[tokio::test]
    async fn detail_applies_project_and_key_filters_and_resets_monthly_totals() {
        let (origin, server) = mock_server(2, |url| {
            let params: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(params["project_ids"], "proj_1");
            assert_eq!(params["api_key_ids"], "key_1");
            assert_eq!(params["bucket_width"], "1d");
            match url.path() {
                "/v1/organization/costs" => {
                    assert_eq!(
                        params["start_time"],
                        midnight(day("2026-10-01")).to_string()
                    );
                    let mut payload = page("2026-10-01", vec![cost(10.0)], None);
                    let data = payload["data"].as_array_mut().unwrap();
                    data.push(
                        json!({"start_time":midnight(day("2026-10-31")),"results":[cost(5.0)]}),
                    );
                    data.push(
                        json!({"start_time":midnight(day("2026-11-01")),"results":[cost(2.0)]}),
                    );
                    (200, payload)
                }
                "/v1/organization/usage/completions" => {
                    assert_eq!(params["group_by"], "model");
                    assert_eq!(
                        params["start_time"],
                        midnight(day("2026-10-31")).to_string()
                    );
                    (
                        200,
                        page(
                            "2026-11-01",
                            vec![
                                json!({"model":"gpt-a","input_tokens":20,"output_tokens":5,"input_cached_tokens":10,"num_model_requests":2}),
                                json!({"model":"gpt-b","input_tokens":8,"output_tokens":3,"num_model_requests":1}),
                            ],
                            None,
                        ),
                    )
                }
                _ => panic!("Unexpected endpoint: {}", url.path()),
            }
        });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let api = Api {
            client: &client,
            key: "test-admin-key",
            origin: &origin,
        };
        let (from, to, end) = (
            day("2026-10-31"),
            day("2026-11-02"),
            midnight(day("2026-11-03")),
        );
        let filter = Filter {
            project: Some("proj_1"),
            key: Some("key_1"),
        };
        let (costs, usage) = tokio::join!(
            api.costs(month_start(from), end, &filter),
            api.completions(from, end, &filter)
        );
        let report = serde_json::to_value(assemble_report(from, to, costs, usage)).unwrap();
        server.join().unwrap();
        assert!(report["costsError"].is_null() && report["usageError"].is_null());
        assert_eq!(report["days"][0]["monthToDate"], 15.0);
        assert_eq!(report["days"][1]["monthToDate"], 2.0);
        assert_eq!(report["days"][1]["inputTokens"], 28);
        assert_eq!(report["days"][1]["requests"], 3);
        assert!(report["days"][1]["cachedInputTokens"].is_null());
        assert!(report["days"][2]["cost"].is_null());
        assert!(report["days"][2].get("requests").is_none());
        assert_eq!(report["models"][0]["name"], "gpt-a");
        assert_eq!(report["models"][0]["cachedInputTokens"], 10);
    }

    #[test]
    fn utc_date_range_and_official_origin_are_enforced() {
        let now = "2026-11-18T12:04:08Z".parse().unwrap();
        let (_, _, end) = report_range("2026-11-18", "2026-11-18", now).unwrap();
        assert_eq!(end, now.timestamp());
        assert!(report_range("2026-11-18", "2026-11-19", now).is_err());
        assert!(report_range("2026-08-01", "2026-11-18", now).is_err());
        assert!(validate_id(Some("../spend_limit")).is_err());
        let client = reqwest::Client::new();
        let mut account = AccountConfig {
            api_key: "test-admin-key".into(),
            base_url: "https://api.openai.com.attacker.test".into(),
            ..Default::default()
        };
        assert!(Api::new(&client, &account).is_err());
        account.base_url = "https://api.openai.com/".into();
        assert!(Api::new(&client, &account).is_ok());
    }
}
