"""Fetch BBH (Big-Bench Hard) subset — tasks used in Symphony paper benchmark."""
import json, os, urllib.request

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

# BBH has 27 tasks; Symphony PoC 用代表性 math/reasoning tasks
TASKS = [
    "boolean_expressions",
    "date_understanding",
    "disambiguation_qa",
    "geometric_shapes",
    "logical_deduction_five_objects",
    "navigate",
    "object_counting",
]

def fetch_bbh(task):
    url = f"https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/main/bbh/{task}.json"
    path = os.path.join(DATA_DIR, f"{task}.json")
    if not os.path.exists(path):
        try:
            urllib.request.urlretrieve(url, path)
            print(f"[fetch] {task} OK")
        except Exception as e:
            print(f"[fetch] {task} FAIL: {e}")
    return path

if __name__ == "__main__":
    for t in TASKS:
        fetch_bbh(t)
    print(f"\nBBH {len(TASKS)} tasks cached to {DATA_DIR}")