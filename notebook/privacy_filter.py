#! /usr/bin/env python3
"""SwarmAI Notebook privacy filter — 任務出網前遮罩敏感字眼.

組合:
  - Regex 預設模式: email / 電話 (en / HK / CN) / IP / 檔案路徑 / 信用卡號 / 金額
  - custom_terms: 用戶自訂敏感詞（公司代號、人名、projects）
用法:
  from privacy_filter import mask_text
  masked, report = mask_text("Contact chris@company.com or call +852 9123 4567, file C:\\Users\\X\\proj")
"""
import re

PATTERNS = {
    "email": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "phone_intl": r"\+\d{1,3}[\s-]?\d{6,14}",
    "phone_hk": r"(?:\(\d{2,4}\)[-\s]?)?\d{4}[\s-]\d{4}",
    "phone_cn": r"1[3-9]\d{9}",
    "ip": r"\b(?:\d{1,3}\.){3}\d{1,3}\b",
    "win_path": r"[A-Za-z]:\\[^\s\"']+",
    "unix_path": r"(?:/[A-Za-z0-9._-]+){2,}",
    "credit_card": r"\b(?:\d[ -]?){13,19}\b",
    "amount": r"(?:USD|HKD|CNY|\$|€|£)\s?\d[\d,]*(?:\.\d+)?",
}


def mask_text(text, custom_terms=None, token="XXXX"):
    """回傳 (masked_text, report{pattern->count})。"""
    if not text:
        return text, {}
    jobj = []
    CT = [c for c in custom_terms or [] if c]
    if CT:
        jobj.append(("custom", re.compile("|".join(re.escape(c) for c in CT))))
    for name, pat in PATTERNS.items():
        jobj.append((name, re.compile(pat)))
    masked = text
    report = {}
    for name, rx in jobj:
        masked, n = rx.subn(token, masked)
        if n:
            report[name] = n
    return masked, report


if __name__ == "__main__":
    sample = (
        "Contact chris@newalgotrade.online or +852 9123 4567. "
        "Design under X-Project, file C:\\Users\\Marco\\docs\\proj. "
        "Budget USD 5,000. IP 100.70.76.100."
    )
    m, rep = mask_text(sample, custom_terms=["X-Project", "Marco"])
    print("masked:", m)
    print("report:", rep)