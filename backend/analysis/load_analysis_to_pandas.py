import boto3
import json
import pandas as pd
from io import BytesIO

# =========================
# CONFIG
# =========================
S3_BUCKET = "drumanalytics-uploads-nsteele"
RESULTS_PREFIX = "results/"

# =========================
# S3 CLIENT
# =========================
s3 = boto3.client("s3")

print("Fetching analysis files from S3...")

response = s3.list_objects_v2(
    Bucket=S3_BUCKET,
    Prefix=RESULTS_PREFIX
)

if "Contents" not in response:
    print("❌ No analysis files found.")
    exit()

analysis_rows = []

for obj in response["Contents"]:
    key = obj["Key"]

    # Skip folders
    if not key.endswith(".json"):
        continue

    print(f"Loading {key}")

    file_obj = s3.get_object(
        Bucket=S3_BUCKET,
        Key=key
    )

    raw_json = file_obj["Body"].read()
    analysis_data = json.loads(raw_json)

    # Flatten one level if needed
    analysis_data["s3_key"] = key
    analysis_data["analysis_timestamp"] = obj["LastModified"]

    analysis_rows.append(analysis_data)

# =========================
# CREATE DATAFRAME
# =========================
df = pd.DataFrame(analysis_rows)

print("\n✅ Loaded analysis data into pandas")
print(df.head())
print("\nColumns:")
print(df.columns)

# Optional: save locally
df.to_csv("all_drum_analysis.csv", index=False)
print("\nSaved all_drum_analysis.csv")