const agents = new Map();

function register(name, handler) {
  agents.set(name, handler);
}

async function invoke(name, ctx, body, editContext) {
  const handler = agents.get(name);
  if (!handler) throw new Error(`Unknown agent: ${name}`);
  return handler(ctx, body, editContext);
}

function has(name) {
  return agents.has(name);
}

module.exports = { register, invoke, has };
