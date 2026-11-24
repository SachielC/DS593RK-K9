# DOG-backed comments API

Run from the project root with Node.js 18+ and a MongoDB replica set.

1. Install the root dependencies with `npm install`.
2. Use the existing RuleKeeper Manager to provision `pep/data.json`, `pep/policies/access_control.wasm`, and `pep/policies/rulekeeper.wasm` under the RuleKeeper Middleware directory. Register the endpoint operations shown below. The comments collection must be in `personal_data_tables`, and its protected field locations and purposes must be in the policy data.
3. Provision users and articles in MongoDB. Each user has a `rulekeeperEntity` matching a key in RuleKeeper's `entities` and `consents`. Each article has an `author` ObjectId pointing to that user. The app resolves comment ownership through the article.
4. Set `MONGODB_URI`, a `JWT_SECRET` of at least 32 bytes, and `RULEKEEPER_READY_PRINCIPAL` to an existing principal. Start with `npm start`, optionally setting `PORT`. The app expects the trusted token issuer to sign an expiring HS256 token with the same secret. The token's `sub` must match the RuleKeeper principal key. Send it as `Authorization: Bearer <token>`.

| Policy operation | JSON body |
|---|---|
| `GET /comments/:id` | None |
| `POST /comments` | `{ "article": "<id>", "body": "text" }` |
| `PATCH /comments/:id` | Fields to update from `article` and `body` |
| `DELETE /comments/:id` | None |
| `POST /comments/batch` | Array of comment objects |
| `PATCH /comments/batch` | Array of `{ "id": "<id>", "fields": { "body": "text" } }` |
| `DELETE /comments/batch` | Array of comment IDs |

The batch endpoints apply one kind of write per request in one transaction. An unauthorized record or failed mutation rolls back the entire request. The two batch endpoints that target existing records require every ID to exist.
