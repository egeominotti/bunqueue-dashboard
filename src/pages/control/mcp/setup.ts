export const EMBEDDED_CONFIG = `{
  "mcpServers": {
    "bunqueue": {
      "command": "bun",
      "args": ["/absolute/path/bunqueue-mcp-runtime/node_modules/.bin/bunqueue-mcp"],
      "env": { "DATA_PATH": "./data/bunq.db" }
    }
  }
}`;

export const TCP_CONFIG = `{
  "mcpServers": {
    "bunqueue": {
      "command": "bun",
      "args": ["/absolute/path/bunqueue-mcp-runtime/node_modules/.bin/bunqueue-mcp"],
      "env": {
        "BUNQUEUE_MODE": "tcp",
        "BUNQUEUE_HOST": "localhost",
        "BUNQUEUE_PORT": "6789",
        "BUNQUEUE_TOKEN": "your-token"
      }
    }
  }
}`;

export const CLI_ADD =
  'claude mcp add bunqueue -- bun /absolute/path/bunqueue-mcp-runtime/node_modules/.bin/bunqueue-mcp';
