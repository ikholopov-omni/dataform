import { IDbClient, IExecutionResult, OnCancel } from "df/core/db_client";
import { dataform, google } from "df/protos/ts";

function deserializeStruct(structValue: google.protobuf.IStruct, fields: dataform.IFieldSchema[]): Object {
    let values = structValue?.fields["f"]?.listValue?.values;
    if (!values) {
        return {};
    }
    return Object.fromEntries(deserializeValues(values, fields).map((value, i) => [fields[i].name, value]));
}

function deserializeValues(values: google.protobuf.IValue[], fields: dataform.IFieldSchema[]): Array<Object | string | null> {
    return values.map(value => value.structValue?.fields["v"])
        .map((value, i) => {
            let field = fields[i];
            if (value.nullValue) {
                return null;
            }
            if (field.type === 'BYTES') {
                return Buffer.from(value.stringValue, 'base64');
            }

            if (field.type === 'RECORD') {
                return deserializeStruct(value.structValue, field.fields);
            }
            return value.stringValue;
        });
}

function deserializeResult(result: dataform.IJitQueryExecutionResult): IExecutionResult {
    return {
        metadata: null,
        rows: result.rows.map(({row}) => deserializeStruct(row, result.fields)),
    };
}

export class JitDbClient implements IDbClient {

    private queriesCounter: number = 0
    private readonly pendingRequests: Map<number, [(result: IExecutionResult) => void, (error: Error) => void]> = new Map();

    public execute(
        statement: string,
        options?: {
            onCancel?: OnCancel;
            interactive?: boolean;
            rowLimit?: number;
            byteLimit?: number;
            bigquery?: {
                labels?: { [label: string]: string };
                location?: string;
                jobPrefix?: string;
                dryRun?: boolean;
            };
        }
    ): Promise<IExecutionResult> {
        return new Promise<IExecutionResult>((resolve, reject) => {
            let id = this.queriesCounter++;
            this.pendingRequests.set(id, [resolve, reject]);
            process.send(dataform.JitExecutionResponse.create({
                adhocQuery: dataform.JitAdhocQueryRequest.create({
                    query: statement,
                    queryId: id,
                })
            }));
        });
    }

    public onMessage(message: dataform.IJitExecutionRequest) {
        const queryId = message.adhocQueryResponse.queryId;
        const [resolve, reject] = this.pendingRequests.get(queryId);
        this.pendingRequests.delete(queryId);

        if (message.adhocQueryResponse.executionError) {
            reject(new Error(message.adhocQueryResponse.executionError));
        } else {
            resolve(deserializeResult(message.adhocQueryResponse.result));
        }
    }
}
