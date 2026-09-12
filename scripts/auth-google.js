import "dotenv/config";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const REDIRECT_URI = "http://localhost:3000/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events"
];

export async function runGoogleAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.");
    process.exitCode = 1;
    return;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const consentUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });

  const server = http.createServer();

  await new Promise((resolve, reject) => {
    server.on("request", async (request, response) => {
      try {
        const requestUrl = new URL(request.url, REDIRECT_URI);

        if (requestUrl.pathname !== "/oauth2callback") {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("Not found.");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        const code = requestUrl.searchParams.get("code");

        if (error) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("Authorization failed. You can close this tab.");
          reject(new Error(`Google authorization failed: ${error}`));
          return;
        }

        if (!code) {
          response.writeHead(400, { "content-type": "text/plain" });
          response.end("Missing authorization code. You can close this tab.");
          reject(new Error("Google callback did not include a code."));
          return;
        }

        const { tokens } = await oauth2Client.getToken(code);

        response.writeHead(200, { "content-type": "text/plain" });
        response.end("Authorization complete. You can close this tab.");

        if (!tokens.refresh_token) {
          reject(new Error("No refresh token returned. This usually means prompt=consent was missing or the app was already authorized. Revoke the app grant in your Google account, then run this script again."));
          return;
        }

        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });

    server.on("error", reject);
    server.listen(3000, () => {
      console.log("Open this URL in your browser to authorize Valey:");
      console.log(consentUrl);
      console.log("Waiting for Google OAuth callback on http://localhost:3000/oauth2callback");
      console.log("If you see 'access blocked, app not verified', add this Google account to the OAuth app test users list.");
      console.log("If no refresh token is returned, revoke the existing app authorization and run this script again.");
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGoogleAuth().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
