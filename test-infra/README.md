# Test Infrastructure

Isolated docker-compose stack for end-to-end matrix tests. Container names use
the `ctxa-test-` prefix and host ports are offset by `+10000` so production
contexa stacks (`contexa-postgres`, etc. on default ports) can run side by
side without colliding.

## Bring up / tear down

```bash
# Start
docker compose -f docker-compose.test.yml -p ctxa-test up -d

# Tear down (drop volumes too, for a clean re-init)
docker compose -f docker-compose.test.yml -p ctxa-test down -v
```

The stack only provisions infrastructure. Contexa schema and seed data are
installed by the `contexa-iam` runtime initializer when the application starts.

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
