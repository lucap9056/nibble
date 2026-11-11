import { Database } from "bun:sqlite";
import schema from "./schema.sql" with { type: "text" };

export enum BubbleOption {
  Enabled = 1 << 0,
  Routing = 1 << 1,
}

export type BubbleRecord = {
  sourcePath: string;
  sourceHash: string;
  name: string;
  options: number;
};

export type CreateBubbleInput = Pick<BubbleRecord, "sourcePath"> &
  Partial<BubbleRecord>;

export type UpdateBubbleInput = Partial<Omit<BubbleRecord, "sourcePath">>;

const BUBBLE_COLUMNS = "sourcePath, sourceHash, name, options";

export const createStorage = (databasePath: string) => {
  const db = new Database(databasePath, { strict: true });

  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(schema);

  const listStatement = db.query<BubbleRecord, []>(
    `SELECT ${BUBBLE_COLUMNS} FROM bubbles ORDER BY sourcePath`,
  );

  const getStatement = db.query<BubbleRecord, { sourcePath: string }>(
    `SELECT ${BUBBLE_COLUMNS} FROM bubbles WHERE sourcePath = $sourcePath`,
  );

  const insertStatement = db.query<BubbleRecord, BubbleRecord>(
    `INSERT INTO bubbles (sourcePath, sourceHash, name, options)
     VALUES ($sourcePath, $sourceHash, $name, $options)
     RETURNING ${BUBBLE_COLUMNS}`,
  );

  const updateStatement = db.query<
    BubbleRecord,
    {
      sourcePath: string;
      sourceHash: string | null;
      name: string | null;
      options: number | null;
    }
  >(
    `UPDATE bubbles SET
       sourceHash = COALESCE($sourceHash, sourceHash),
       name = COALESCE($name, name),
       options = COALESCE($options, options)
     WHERE sourcePath = $sourcePath
     RETURNING ${BUBBLE_COLUMNS}`,
  );

  const deleteStatement = db.query<
    Pick<BubbleRecord, "sourcePath">,
    { sourcePath: string }
  >("DELETE FROM bubbles WHERE sourcePath = $sourcePath RETURNING sourcePath");

  const listBubbles = (): BubbleRecord[] => listStatement.all();

  const getBubble = (sourcePath: string): BubbleRecord | null =>
    getStatement.get({ sourcePath });

  const createBubble = ({
    sourcePath,
    sourceHash = "",
    name = "",
    options = 0,
  }: CreateBubbleInput): BubbleRecord => {
    const row = insertStatement.get({ sourcePath, sourceHash, name, options });
    if (row === null) {
      throw new Error(`Failed to insert bubble: ${sourcePath}`);
    }
    return row;
  };

  const updateBubble = (
    sourcePath: string,
    { sourceHash, name, options }: UpdateBubbleInput,
  ): BubbleRecord | null =>
    updateStatement.get({
      sourcePath,
      sourceHash: sourceHash ?? null,
      name: name ?? null,
      options: options ?? null,
    });

  const deleteBubble = (sourcePath: string): boolean =>
    deleteStatement.get({ sourcePath }) !== null;

  const close = () => db.close();

  return {
    listBubbles,
    getBubble,
    createBubble,
    updateBubble,
    deleteBubble,
    close,
  };
};

export type Storage = ReturnType<typeof createStorage>;
