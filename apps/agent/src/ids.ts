// Допустимые идентификаторы (sessionId, userId, jobId, префиксы томов): попадают
// в имена контейнеров и томов, пути Docker API и пути scratch (`rm -rf` от root),
// поэтому только `[A-Za-z0-9_-]`, не длиннее 64.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidId = (id: string) => ID_PATTERN.test(id);
