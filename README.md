# Media Vault

Media Vault is an admin interface for managing the files published by the `prem143-sm/SamsBday` website. It reads and commits changes directly to that repository:

- Photos: `public/Photos/optimized/`
- Music: `public/music/Sams-Playlist/` and `public/music/Prems-Playlist/`

The website's existing build scans those same folders, so new files are included in its generated photo and music manifests when SamsBday redeploys.

## Local development

```sh
npm install
cp .env.example .env
npm run dev
```

Set `ADMIN_USERNAME` and a private random `AUTH_SECRET` of at least 32 characters. Public SamsBday media can be listed without GitHub credentials. Adding and deleting files requires a fine-grained GitHub token with **Contents: Read and write** permission for `prem143-sm/SamsBday`. Adding files also requires a Vercel Blob read/write token for private upload staging.

The UI supports browsing, searching, and previewing photos, playing music, adding files, and deleting files. Uploaded photos are converted to WebP and committed into the optimized photo folder. Music is uploaded to the selected playlist. GitHub commits trigger the normal website deployment.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | User ID used to sign in |
| `AUTH_SECRET` | Yes | Random signing key, at least 32 characters |
| `GITHUB_OWNER` | No | Defaults to `prem143-sm` |
| `GITHUB_REPOSITORY` | No | Defaults to `SamsBday` |
| `GITHUB_BRANCH` | No | Defaults to `main` |
| `GITHUB_TOKEN` | For add/delete | Fine-grained token limited to `SamsBday`, with Contents read/write |
| `BLOB_READ_WRITE_TOKEN` | For add | Vercel Blob token for temporary private uploads |

Never commit `.env` or use browser-exposed prefixes for secrets. User-ID-only sign-in is not strong authentication: anyone who can reach the app and knows the configured ID can sign in. Restrict access to the app if this exposure is not acceptable.

## API

- `GET /api/auth`, `POST /api/auth`, `DELETE /api/auth`: session check, user-ID login, logout.
- `GET /api/library`: list photos and music in the configured SamsBday repository.
- `POST /api/library`: validate staged uploads and commit them to the correct media folder.
- `DELETE /api/library?path=...`: delete a listed photo or music file.
- `POST /api/upload-token`: issue a constrained private temporary upload token.

Sessions use signed, HttpOnly, SameSite=Strict cookies with an eight-hour inactivity expiry. Mutations require the in-memory CSRF token and same-origin requests. Login attempts are rate-limited per function instance. Use HTTPS in production.

## Build, tests, and deployment

```sh
npm run build
npm test
```

Deploy this repository as a Vercel project with the repository root as its Root Directory. Configure `ADMIN_USERNAME`, `AUTH_SECRET`, `GITHUB_TOKEN`, and `BLOB_READ_WRITE_TOKEN` in the Vercel Production environment. `GITHUB_OWNER`, `GITHUB_REPOSITORY`, and `GITHUB_BRANCH` can use their defaults. The GitHub token must be restricted to `prem143-sm/SamsBday`; never expose it to the browser.
