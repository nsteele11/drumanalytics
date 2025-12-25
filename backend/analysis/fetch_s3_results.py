import boto3
import os
import json

# ---------- CONFIG ----------
BUCKET_NAME = "drumanalytics-uploads-nsteele"
S3_PREFIX = "results/"   # where analysis JSONs are stored in S3
LOCAL_OUTPUT_DIR = "downloaded_results"
# ----------------------------

# Create local folder if it doesn't exist
os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)

# Create S3 client (uses your working AWS credentials automatically)
s3 = boto3.client("s3")

print("Fetching list of analysis files from S3...")

response = s3.list_objects_v2(
    Bucket=BUCKET_NAME,
    Prefix=S3_PREFIX
)

if "Contents" not in response:
    print("❌ No analysis files found in S3.")
    exit()

for obj in response["Contents"]:
    key = obj["Key"]

    # Skip folders
    if key.endswith("/"):
        continue

    local_filename = os.path.join(
        LOCAL_OUTPUT_DIR,
        os.path.basename(key)
    )

    print(f"Downloading {key} → {local_filename}")

    s3.download_file(
        BUCKET_NAME,
        key,
        local_filename
    )

print("✅ All analysis files downloaded successfully.")