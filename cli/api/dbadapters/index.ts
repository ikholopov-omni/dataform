import { QueryOrAction } from "df/cli/api/dbadapters/execution_sql";
import type { IDbClient, IExecutionResult, OnCancel } from "df/core/db_client";
import { dataform } from "df/protos/ts";

export { IDbClient, IExecutionResult, OnCancel };

export interface IBigQueryError extends Error {
  metadata?: dataform.IExecutionMetadata
}

export interface IDbAdapter extends IDbClient {
  withClientLock<T>(callback: (client: IDbClient) => Promise<T>): Promise<T>;

  evaluate(queryOrAction: QueryOrAction): Promise<dataform.IQueryEvaluation[]>;

  schemas(database: string): Promise<string[]>;
  createSchema(database: string, schema: string): Promise<void>;

  // TODO: This should take parameters to allow for retrieving from a specific database/schema.
  tables(): Promise<dataform.ITarget[]>;
  search(searchText: string, options?: { limit: number }): Promise<dataform.ITableMetadata[]>;
  table(target: dataform.ITarget): Promise<dataform.ITableMetadata>;

  setMetadata(action: dataform.IExecutionAction): Promise<void>;
}
