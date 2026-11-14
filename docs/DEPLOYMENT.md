# Deployment

The repository includes `render.yaml` for a single Node web service. Express serves the built React client and an embedded 2 Hz simulator. MongoDB must be an external persistent database. No hosted service is provisioned by these files.

## Prepare the database

1. Create a dedicated MongoDB database and a user with access to that database. Configure the provider's network access for both seeding and the eventual host.
2. In your local untracked `.env`, set the deployment `MONGO_URI`, separate random `JWT_SECRET` and `FLEET_SECRET` values of at least 32 characters, and your chosen `DEMO_PASSWORD`.
3. Run `npm run seed` once against that dedicated database. This creates indexes, the fleet, gateway hashes, and accounts. Use the same fleet secret and password on the host. Seeding again rotates seeded credentials; coordinate it with the running simulator. Do not run the reset option on retained data.

Generate each secret separately, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

## Configure the service

Connect the private GitHub repository to Render and choose the repository root. Use the supplied Blueprint, or enter these settings manually:

| Setting                                       | Value                                               |
| --------------------------------------------- | --------------------------------------------------- |
| Runtime                                       | Node 22                                             |
| Build                                         | `npm ci --include=dev && npm run build`             |
| Start                                         | `npm start`                                         |
| Health check                                  | `/readyz`                                           |
| `NODE_ENV`                                    | `production`                                        |
| `HOST`                                        | `0.0.0.0`                                           |
| `MONGO_URI`                                   | Dedicated database connection string                |
| `JWT_SECRET`, `FLEET_SECRET`, `DEMO_PASSWORD` | Same secrets used when provisioning                 |
| `SIM_EMBEDDED`, `SIM_HZ`                      | `1`, `2`                                            |
| `CORS_ORIGINS`                                | Exact public HTTPS origin, without a trailing slash |

The server uses the host's `PORT`; local development defaults to 4000. Ensure `CORS_ORIGINS` matches the final URL after it is assigned. The server's live-namespace origin check and CSP both use this configuration. A custom domain needs its own exact origin. The default OpenStreetMap basemap is already permitted; a different tile origin needs a CSP update and appropriate attribution.

Render requires web services to bind to `0.0.0.0` and supports an HTTP health-check path. See the official [web-service guide](https://render.com/docs/web-services), [Node-version settings](https://render.com/docs/node-version), and [health-check guide](https://render.com/docs/health-checks).

## Verify the deployment

Check `/readyz`, sign in, confirm sensor counts and new timestamps, inspect metrics for writes, and test a ranger session alongside the administrator. Confirm the ranger receives only its zone. Generate an ignition and verify an incident persists after a page reload. Reconnect a browser and confirm live delivery resumes.

Use a single service instance. Sleeping/free hosts can interrupt the simulator; timestamps resume when the process restarts. Database capacity and retention determine storage costs, so measure the hosted 2 Hz workload before increasing it. The 10 Hz local benchmark does not establish hosted capacity. The local database helper is for development, not persistent cloud storage.

One-click login uses `ember-demo`; with a custom password use the normal sign-in form. A hosted URL and recorded demo video remain separate submission artifacts once the application is deployed and recorded.
