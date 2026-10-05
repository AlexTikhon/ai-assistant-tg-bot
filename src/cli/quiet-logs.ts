// Imported FIRST (right after dotenv) by the operational commands: they print their own report, so the structured application log
// (one JSON line per operation) is limited to warnings and errors unless LOG_LEVEL says otherwise (an .env or the environment wins).
// It must run before the logger module is first evaluated, which is why it is a module of its own and not a statement in each command.
process.env.LOG_LEVEL ??= "warn";
