// D1 helpers. undefined is not a valid D1 binding, so it becomes null.
const fix = (p) => p.map((v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));

export const stmt = (env, sql, ...p) => env.DB.prepare(sql).bind(...fix(p));
export const one = (env, sql, ...p) => stmt(env, sql, ...p).first();
export const all = async (env, sql, ...p) => (await stmt(env, sql, ...p).all()).results ?? [];
export const run = (env, sql, ...p) => stmt(env, sql, ...p).run();
export const insert = async (env, sql, ...p) => (await run(env, sql, ...p)).meta.last_row_id;
export const batch = (env, stmts) => env.DB.batch(stmts);

// Builds "a = ?, b = ?" for an UPDATE from an object of columns.
export function update(env, table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  return run(env, sql, ...keys.map((k) => fields[k]), id);
}
