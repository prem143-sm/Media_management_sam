# Media Vault

Media Vault is an independently deployable admin app for a GitHub-hosted photo and music repository. It does not import, route through, or require the birthday website.

## Local development

From this directory:

```sh
npm install
cp .env.example .env
npm run hash-password
npm run dev
```

Paste the generated `ADMIN_PASSWORD_HASH` into `.env`; choose an `ADMIN_USERNAME` and a random `AUTH_SECRET` of at least 32 characters. Configure the GitHub values below to connect a repository. For uploads, configure a Vercel Blob read/write token as well; Blob is used only as private, temporary staging because GitHub credentials and large file bytes must not pass through the browser or a small JSON request. The GitHub repository remains the permanent source of truth.

The app is served at `http://localhost:5173`. Without GitHub settings, the app can start and display the setup error, but cannot load or change repository media.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_USERNAME` | Yes | Single admin login name |
| `ADMIN_PASSWORD_HASH` | Yes | `scrypt$<salt>$<hex digest>`; generate with `npm run hash-password` |
| `AUTH_SECRET` | Yes | Random signing key, at least 32 characters |
| `GITHUB_TOKEN` | Yes | Fine-grained token restricted to the media repo |
| `GITHUB_OWNER` | Yes | GitHub account or organization |
| `GITHUB_REPOSITORY` | Yes | Media repository name |
| `GITHUB_BRANCH` | No | Branch to update; defaults to `main` |
| `BLOB_READ_WRITE_TOKEN` | Yes for uploads | Vercel Blob token for private, temporary upload staging |
| `MEDIA_MAX_BUNDLE_SIZE_MB` | No | Photo bundle capacity, 1–100 MB; defaults to 100 |
| `MEDIA_TIMEZONE` | No | Display/configuration preference; defaults to `Asia/Kolkata` |

Never commit `.env`. Never use a `VITE_`, `NEXT_PUBLIC_` or other browser-exposed prefix for a secret. The password itself is not stored; only its scrypt hash is configured.

## GitHub repository setup and permissions

Create a dedicated media repository and a fine-grained personal access token limited to that repository. Grant **Contents: Read and write** and **Metadata: Read-only**. The app reads and writes media and manifests through GitHub’s Git Data API. It does not use GitHub as a database for credentials, sessions, or upload state.

The GitHub repository should be public if another unauthenticated website will use the generated `raw.githubusercontent.com` URLs. For a private repository, a consumer needs its own authenticated delivery or a CDN; do not copy this admin token into that website.

## Photo processing and bundles

JPG/JPEG, PNG, WebP and GIF uploads are decoded in the browser, auto-oriented by the browser image decoder, flattened to WebP at quality 0.84, and stripped of original metadata by re-encoding. GIF uploads use the browser-decoded frame. Browser-native HEIC/HEIF conversion is not assumed; unsupported files are rejected with a clear message.

Converted photos are assigned sequentially to the latest bundle that can fit them. When the next photo would exceed the configured cap, the app creates the next `bundle-NNN` folder. A single photo larger than the cap is rejected. The cap can never be configured above 100 MB. GitHub’s individual file limit is also enforced; Git LFS is not implemented.

Each `photos/bundle-NNN/manifest.json` contains the bundle ID, count, byte size, timestamps and per-photo IDs, paths, dimensions, sizes and upload times. The root `media-manifest.json` contains only versioned bundle summaries and paths, not photo bytes. Photo file and manifest changes are written in one Git tree/commit, and the branch ref update is non-forced to prevent concurrent writers from silently overwriting one another. A conflict is returned for the admin to refresh and retry.

Temporary uploads use private Vercel Blob staging. The browser receives a short-lived, constrained upload token, never the GitHub token. The API validates extensions and file signatures before adding staged bytes to a GitHub commit, and deletes staged blobs after a successful commit. A failed operation does not publish manifest references to uncommitted media.

## Music management

Supported extensions are MP3, WAV, M4A, OGG, FLAC and AAC. Files are signature-checked server-side and organized under `music/human-mode/` or `music/divine-mode/`. `music/playlist.json` holds versioned playlist arrays with a track ID, title, filename, repository path, byte size and upload time. A music file and playlist update are committed together.

## API and security

- `GET /api/auth`, `POST /api/auth`, `DELETE /api/auth`: session check, login and logout.
- `GET /api/media`, `GET /api/media?bundle=bundle-001`: dashboard and bundle metadata.
- `POST /api/media`: validate staged uploads and commit a batch (up to 20 files per commit).
- `DELETE /api/media?kind=photo|music&id=...`: delete media and update manifests atomically.
- `POST /api/upload-token`: issue a constrained private temporary upload token.

Sessions are signed, HttpOnly, SameSite=Strict cookies with a sliding eight-hour inactivity expiry; authenticated API activity renews the session. Mutations also require an in-memory CSRF token and same-origin requests. Login attempts are rate-limited per server instance. Use HTTPS in production. Vercel serverless rate limits are per instance, not a global distributed lock; branch updates use GitHub’s non-forced ref update as the cross-instance concurrency guard.

GitHub tokens and auth secrets are only read by server routes. User-visible errors do not include token values or stack traces. Temporary storage is required for uploads; it is not used as the published media source. Configure Blob access and repository permissions narrowly.

## Build and independent Vercel deployment

```sh
npm run build
npm test
npm run preview
```

Deploy this folder as its own Vercel project:

1. Import the Git repository into a new Vercel project.
2. Set **Root Directory** to `media-manager`.
3. Add the environment variables above to the appropriate Vercel environment.
4. Deploy and open the project URL.

The included `vercel.json` builds the Vite SPA and configures the API function duration. This deployment is separate from the birthday website; neither app needs to be available for the other to run.

## Future website consumption

A future consumer can fetch:

```text
https://raw.githubusercontent.com/<owner>/<repository>/<branch>/media-manifest.json
```

Read `photoBundles`, choose one summary at random, then fetch only that bundle’s `photos/<bundle-id>/manifest.json`. The bundle manifest lists that bundle’s WebP files and their dimensions/paths. Load images only from those paths; do not enumerate or fetch every bundle. The global manifest’s `version` and `updatedAt` values can be used for cache invalidation. The Media Vault does not implement this random selection or integrate with the birthday website.
