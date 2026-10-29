# Ports and processes

| port | process | status |
|---|---|---|
| 12000 | pm2 `gramene-kg-api` (Fastify; REST `/kg/v1`, GraphQL `/kg/graphql`, UI `/kg/ui`) | reserved, M1a |
| 12001 | dev instance of the API | reserved |
| 11067 | pm2 `gramene-mcp-kg` (staging MCP from a separate gramene-mcp checkout) | reserved, M2 |
| 7474/7687 | Neo4j CE (127.0.0.1 only) | M5, only after the M4 go decision |

Verified free on 2026-10-27/29. Taken nearby: 11065 (live gramene-mcp), 11066, 11068-11070 (ebeye),
10066-10070 (gramene_swagger). Never `pm2 restart all`.
