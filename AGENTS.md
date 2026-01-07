# Repository Guidelines

## Project Structure & Module Organization
- `api/` holds Vercel serverless endpoints. Key routes: `api/copilot.js` (main copilot) and `api/chat.js` (follow-up chat). Related helpers live under `api/copilot/`.
- `lib/` contains shared services and domain modules (Notion, OpenAI, Zendesk, auth, rate limiting). Context assembly is under `lib/context/`, and LLM generators are in `lib/modules/`.
- `zendesk-app/` is the Zendesk sidebar app (ZAF). UI assets live in `zendesk-app/assets/`, translations in `zendesk-app/translations/`, and config in `zendesk-app/manifest.json`.
- `HIVE-COPILOT.md` is the detailed product/architecture overview.

## Build, Test, and Development Commands
- `npm run dev` starts local development via `vercel dev` for API endpoints.
- `npm run deploy` deploys the API to Vercel production.
- `zip -r hive-copilot-zendesk-app.zip zendesk-app -x "*.DS_Store"` packages the Zendesk app for upload.

## Coding Style & Naming Conventions
- JavaScript (CommonJS) with 2-space indentation, double quotes, and semicolons; match existing formatting.
- Filenames are lower-case with dashes in `api/` and camelCase in `lib/` (e.g., `contextAssembler.js`). Keep new files consistent with adjacent patterns.

## Testing Guidelines
- No automated test suite is configured. Validate manually:
  - API: `npm run dev` and hit `POST /api/copilot` or `POST /api/chat`.
  - Zendesk app: open `zendesk-app/assets/index.html` or upload the zip to Zendesk.

## Commit & Pull Request Guidelines
- Git history is minimal (initial commit only). Use clear, sentence-case commit summaries.
- PRs should include a concise description, testing notes, and screenshots for UI changes in `zendesk-app/`.

## Security & Configuration Tips
- Required env vars (set in Vercel or local shell): `OPENAI_API_KEY`, `NOTION_API_TOKEN`, `NOTION_ROOT_PAGE_ID` (optional), `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_TOKEN`.
- Never commit secrets, API tokens, or credentials. Use `.env` locally and Vercel project settings in production.

## Zendesk App Notes
- Ensure both icons exist in `zendesk-app/assets/`: `logo.png` (512x512) and `logo-small.png` (128x128). Missing `logo-small.png` shows a gear icon.
- `manifest.json` should use `ticket_sidebar` with `frameworkVersion: "2.0"` and no `svg_icon` property.

## Agent-Specific Instructions
- If changes modify features, endpoints, deployment steps, or environment variables, update the Notion documentation page linked in `HIVE-COPILOT.md`. Skip docs updates for minor refactors or styling-only changes.
