// Tests run as a neutral caller. Run inside an agent conversation, the shell
// carries that conversation's identity, which the CLI would otherwise treat as
// the caller (and the PORT of whatever Web it last used, or Claude Desktop).
for (const name of ['CHILL_AGENT_HARNESS','CHILL_AGENT_SESSION_ID','CHILL_AGENT_CONNECTION_GENERATION','CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID','CHILL_AGENT_DATA_DIR','PORT','CLAUDE_CODE_ENTRYPOINT'])
  delete process.env[name];
