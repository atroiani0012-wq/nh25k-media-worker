# NH25K Campaign Media Worker

Dedicated final-video rendering lane for the Newlywed Head Start Campaign.

Every five minutes, GitHub Actions authenticates to Campaign Core with a
short-lived OIDC token, claims only media-render jobs, creates a 1080×1920 MP4
with FFmpeg, validates the finished file, and uploads it to Campaign Core.
Upload-Post receives only the final validated MP4.

This repository stores no campaign API key. Campaign Core binds access to this
repository's immutable ID, owner ID, `main` branch, and exact workflow path.
Forks and copied workflows are rejected.
