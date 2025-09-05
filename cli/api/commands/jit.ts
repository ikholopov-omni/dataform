import { Task } from "df/cli/api/dbadapters/tasks";
import { IDbClient } from "df/core/db_client";
import { dataform } from "df/protos/ts";

export async function jitCompile(client: IDbClient, jitTask: Task, runConfig: dataform.IRunConfig): Promise<Task> {
    
}
