# Test Infrastructure

Isolated docker-compose stack for end-to-end matrix tests. Container names use
the `ctxa-test-` prefix and host ports are offset by `+10000` so production
contexa stacks (`contexa-postgres`, etc. on default ports) can run side by
side without colliding.

## Bring up / tear down

```bash
# Generate the seed schema first (required on FIRST start of each volume)
node ../scripts/seed-test-initdb.cjs

# Start
docker compose -f docker-compose.test.yml -p ctxa-test up -d

# Tear down (drop volumes too, for a clean re-init)
docker compose -f docker-compose.test.yml -p ctxa-test down -v
```

## Why is `initdb/` gitignored?

The `02-dml.sql` script contains a freshly randomized BCrypt seed password
generated on every `contexa init`. Committing it would publish that password
hash to the repository history. The directory is generated on demand by
`scripts/seed-test-initdb.cjs` (or the matrix runner, which calls the same
core helper before bringing the stack up).

## Endpoints (host ports)

| Service     | Container             | Host port |
|-------------|-----------------------|-----------|
| PostgreSQL  | ctxa-test-postgres    | 15432     |
| Ollama      | ctxa-test-ollama      | 21434     |
| Redis       | ctxa-test-redis       | 16379     |
| Zookeeper   | ctxa-test-zookeeper   | 12181     |
| Kafka       | ctxa-test-kafka       | 19092     |

## DB credentials

```
db_name      = contexa_test
db_username  = contexa_test
db_password  = contexa_test_pw
jdbc_url     = jdbc:postgresql://localhost:15432/contexa_test
```
