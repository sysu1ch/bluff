# Repository Guidelines

## Project Structure & Module Organization
This project is a small Node.js multiplayer card game. `server.js` contains the Express server, WebSocket handling, room state, and game rules. The browser client lives in `public/`: `index.html` defines the UI, `app.js` manages client state and socket events, and `styles.css` holds layout and visual styling. `README.md` documents local startup and deployment notes. Keep new runtime code in these existing entry points unless the project is explicitly being refactored.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm start`: start the server with `node server.js`.
- `HOST=0.0.0.0 PORT=3000 npm start`: run with explicit bind address and port on Unix-like shells.
- PowerShell: `$env:HOST="0.0.0.0"; $env:PORT="3000"; npm start`

After startup, open `http://localhost:3000`. There is no separate build step or hot-reload script in `package.json`.

## Coding Style & Naming Conventions
Follow the existing plain JavaScript style: 2-space indentation, semicolons, double quotes, and small helper functions. Use `camelCase` for variables and functions, `UPPER_SNAKE_CASE` for shared constants such as `MAX_PLAYERS`, and short descriptive names for room or socket actions. Keep browser code in `public/app.js` DOM-focused, and keep game-state or server-side validation in `server.js`.

## Testing Guidelines
There is currently no automated test suite and no `npm test` script. For changes, run `npm start` and verify behavior manually in multiple browser tabs:
- create and join rooms
- start a game and play rounds
- reconnect/refresh and confirm room state updates

If you add automated coverage, keep it lightweight and document the command in `package.json` and `README.md`. Place tests in a dedicated `tests/` directory or alongside new modules if the project is refactored.

## Commit & Pull Request Guidelines
Recent commits use short, imperative summaries in Chinese. Keep commit messages concise, focused on user-visible behavior, and avoid mixing unrelated changes in one commit.

Pull requests should include:
- a brief summary of gameplay or networking changes
- manual test notes with the scenarios you checked
- screenshots or short recordings for UI changes in `public/`
- linked issues or task references when available

## Configuration & Deployment Notes
This server stores rooms and game state in process memory. A restart clears active rooms, so do not describe the app as persistent unless storage is added. When deploying behind a reverse proxy, ensure WebSocket upgrade requests are forwarded correctly.
