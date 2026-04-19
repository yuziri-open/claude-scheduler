# Example: Daily status report prompt
#
# This is a sample prompt file for claude-scheduler.
# Place your own prompt files in this directory and reference them with --prompt-file.
#
# Usage:
#   claude-scheduler add \
#     --name "daily-report" \
#     --cron "0 9 * * 1-5" \
#     --prompt-file ./prompts/example-daily-report.md

You are a helpful assistant. Generate a brief daily status report.

1. Check the current date and time.
2. Summarize what tasks are pending in the project directory.
3. List any files modified in the last 24 hours.
4. Output a short markdown report to `reports/YYYY-MM-DD.md`.

Keep the report concise — under 200 words.
