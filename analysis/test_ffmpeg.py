import subprocess

# Run the ffmpeg command
result = subprocess.run(
    ["ffmpeg", "-version"],
    capture_output=True,
    text=True
)

# Print only the first line of output
print(result.stdout.splitlines()[0])