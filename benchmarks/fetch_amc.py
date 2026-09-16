"""Fetch AMC (AIME/AMC) competition math problems — Symphony paper benchmark."""
import json, os, urllib.request

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
TASKS = ["2024", "2023", "2022"]

# AMC data sources vary; placeholder fetcher for open sources (HuggingFace mirror)
# e.g. huggyllama/AMC12-HARD style datasets. 填返實際 URL 相應階段。
def fetch_amc(year):
    # TODO: 用實際可 fetch 嘅 dataset（e.g. openlemma / NuminaMath)
    path = os.path.join(DATA_DIR, f"amc_{year}.json")
    if not os.path.exists(path):
        with open(path, "w") as f:
            json.dump({"year": year, "problems": []}, f)
        print(f"[fetch] amc_{year} placeholder (未連 source)")
    return path

if __name__ == "__main__":
    for y in TASKS:
        fetch_amc(y)
    print(f"\nAMC {len(TASKS)} tasks cached to {DATA_DIR}")