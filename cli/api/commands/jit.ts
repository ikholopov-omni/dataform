import { BigQuery } from "@google-cloud/bigquery";
import bigquery from "@google-cloud/bigquery/build/src/types";
import { ChildProcess, fork } from "child_process";
import { coerceAsError } from "df/common/errors/errors";

import { IDbClient } from "df/core/db_client";
import { dataform, google } from "df/protos/ts";
import { ExecutionSql } from "df/cli/api/dbadapters/execution_sql";
import { IExecutionOptions } from "df/cli/api/commands/run";

export class JitCompilationTimeoutError extends Error { }

function makeField(name: string, schema: bigquery.IQueryParameterType): dataform.IFieldSchema {
    if (schema.type === 'RECORD') {
        let fields = schema.structTypes.map(child => makeField(child.name, child.type));
        return {
            name: name,
            type: 'RECORD',
            fields: fields,
        };
    }
    return {
        name: name,
        type: schema.type,
    };
}

function makeRowValue(value: any, schema: dataform.IFieldSchema): google.protobuf.IStruct {
    if (schema.type === 'RECORD') {
        return { fields: { "v": { structValue: makeRowStruct(value, schema.fields) } } };
    }
    if (schema.type === 'BYTES') {
        return { fields: { "v": { stringValue: value.toString('base64') } } };
    }

    return { fields: { "v": { stringValue: value.toString() } } };
}

function makeRowStruct(structValue: Object, fields: dataform.IFieldSchema[]): google.protobuf.IStruct {
    return {
        fields: {
            "f": {
                listValue: {
                    values: Object.entries(structValue).map(
                        ([_, value], index) => ({ structValue: makeRowValue(value, fields[index]) })
                    )
                }
            }
        }
    };
}

function serializeRows(rows: Object[]): [dataform.IJitQueryRow[], dataform.IFieldSchema[]] {
    if (!rows.length) {
        return [[], []];
    }
    let fields: dataform.IFieldSchema[] = [];

    for (let [key, value] of Object.entries(rows[0])) {
        fields.push(makeField(key, BigQuery.getTypeDescriptorFromValue_(value)));
    }
    let row_values = rows.map(row => ({
        row: makeRowStruct(row, fields)
    }));
    return [row_values, fields];
}

function forkProcess() {
    const findForkScript = () => {
        try {
            const workerBundlePath = require.resolve("./worker_jit_bundle");
            return workerBundlePath;
        } catch (e) {
            return require.resolve("../../vm/compile_jit_loader");
        }
    };

    const forkScript = findForkScript();
    return fork(require.resolve(forkScript), [], { stdio: [0, 1, 2, "ipc", "pipe"] });
}

function jitCompileInFork(client: IDbClient,
    action: dataform.IExecutionAction, jitTask: dataform.IExecutionTask,
    projectDir: string,
    jitContextData: google.protobuf.IValue,
): [Promise<string>, ChildProcess] {
    const childProcess = forkProcess();
    let compileInChildProcess = new Promise<string>(async (resolve, reject) => {
        childProcess.on("error", (e: Error) => reject(coerceAsError(e)));
        childProcess.on("message", (message: dataform.IJitExecutionResponse) => {
            if (message.compilationResponse?.compilationError) {
                reject(new Error(message.compilationResponse.compilationError));
                return;
            }
            if (message.compilationResponse) {
                resolve(message.compilationResponse.query);
                return;
            }
            const result = client.execute(message.adhocQuery.query);
            result.then(({ rows }) => {
                let [row_values, fields] = serializeRows(rows);
                let result = {
                    rows: row_values,
                    fields: fields,
                };
                childProcess.send(dataform.JitExecutionRequest.create({
                    adhocQueryResponse: {
                        queryId: message.adhocQuery.queryId,
                        result: result,
                    }
                }));
            });
        });
        childProcess.on("close", exitCode => {
            if (exitCode !== 0) {
                reject(new Error(`Compilation child process exited with exit code ${exitCode}.`));
            }
        });
        childProcess.send(dataform.JitExecutionRequest.create({
            compile: {
                projectDir: projectDir,
                statement: jitTask.statement,
                action: action,
                jitContextData: jitContextData,
            }
        }));
    });
    return [compileInChildProcess, childProcess];
}

export async function jitCompile(
    client: IDbClient,
    action: dataform.IExecutionAction, jitTask: dataform.IExecutionTask,
    graph: dataform.IExecutionGraph, executionOption: IExecutionOptions
): Promise<dataform.IExecutionTask[]> {
    let [compileInChildProcess, childProcess] = jitCompileInFork(client,
        action, jitTask, executionOption.projectDir, graph.jitContextData);
    let timer;
    const timeout = new Promise(
        (resolve, reject) =>
        (timer = setTimeout(
            () => reject(new JitCompilationTimeoutError("Compilation timed out")),
            graph.runConfig.timeoutMillis || 5 * 60 * 1000
        ))
    );
    try {
        await Promise.race([timeout, compileInChildProcess]);
        const result = await compileInChildProcess;
        const executionSql = new ExecutionSql(graph.projectConfig, executionOption.dataformCoreVersion);
        if (action.tableType === "operation") {
            return [{
                type: "operation",
                statement: result,
            }];
        }
        const table = {
            ...action,
            enumType: dataform.TableType[
                action.tableType.toUpperCase() as keyof typeof dataform.TableType
            ],
            query: result,
        };
        return executionSql.publishTasks(table,
            graph.runConfig,
            graph.warehouseState.tables
                .find(table => !!table?.target?.name && (table?.target?.name === action?.target?.name)))
            .build();
    } finally {
        if (!childProcess.killed) {
            childProcess.kill("SIGKILL");
        }
        if (timer) {
            clearTimeout(timer);
        }
    }
}
