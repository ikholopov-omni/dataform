import * as fs from "fs";
import * as path from "path";
import { NodeVM } from "vm2";

import { dataform, google } from "df/protos/ts";
import { IDbClient } from "df/core/db_client";
import { Resolvable } from "df/core/contextables";
import { resolvableAsTarget, toResolvable } from "df/core/utils";
import { JitDbClient } from "df/cli/vm/jit_db_client";

class TargetSet {
  private byName: Map<string, dataform.ITarget[]> = new Map();
  private bySchemaAndName: Map<string, Map<string, dataform.ITarget[]>> = new Map();
  private byDatabaseAndName: Map<string, Map<string, dataform.ITarget[]>> = new Map();
  private byDatabaseSchemaAndName: Map<string, Map<string, Map<string, dataform.ITarget[]>>> = new Map();

  public constructor(targets: dataform.ITarget[]) {
    for (const target of targets) {
      this.set(target);
    }
  }

  public set(actionTarget: dataform.ITarget) {
    this.setByNameLevel(this.byName, actionTarget.name, actionTarget);

    if (!!actionTarget.schema) {
      this.setBySchemaLevel(this.bySchemaAndName, actionTarget);
    }

    if (!!actionTarget.database) {
      if (!this.byDatabaseAndName.has(actionTarget.database)) {
        this.byDatabaseAndName.set(actionTarget.database, new Map());
      }
      const forDatabaseNoSchema = this.byDatabaseAndName.get(actionTarget.database);
      this.setByNameLevel(forDatabaseNoSchema, actionTarget.name, actionTarget);

      if (!!actionTarget.schema) {
        if (!this.byDatabaseSchemaAndName.has(actionTarget.database)) {
          this.byDatabaseSchemaAndName.set(actionTarget.database, new Map());
        }
        const forDatabase = this.byDatabaseSchemaAndName.get(actionTarget.database);
        this.setBySchemaLevel(forDatabase, actionTarget);
      }
    }
  }

  public find(target: dataform.ITarget) {
    if (!!target.database) {
      if (!!target.schema) {
        return (
          this.byDatabaseSchemaAndName
            .get(target.database)
            ?.get(target.schema)
            ?.get(target.name) || []
        );
      }
      return this.byDatabaseAndName.get(target.database)?.get(target.name) || [];
    }
    if (!!target.schema) {
      return this.bySchemaAndName.get(target.schema)?.get(target.name) || [];
    }
    return this.byName.get(target.name) || [];
  }


  private setByNameLevel(targetMap: Map<string, dataform.ITarget[]>, name: string, target: dataform.ITarget) {
    if (!targetMap.has(name)) {
      targetMap.set(name, []);
    }
    targetMap.get(name).push(target);
  }

  private setBySchemaLevel(
    targetMap: Map<string, Map<string, dataform.ITarget[]>>,
    actionTarget: dataform.ITarget,
  ) {
    if (!targetMap.has(actionTarget.schema)) {
      targetMap.set(actionTarget.schema, new Map());
    }
    const forSchema = targetMap.get(actionTarget.schema);
    this.setByNameLevel(forSchema, actionTarget.name, actionTarget);
  }
}


function ref_impl(dependencies?: dataform.ITarget[]) {
  const targets = new TargetSet(dependencies ?? []);

  function ref(ref: Resolvable | string[], rest?: string[]): string {
    const target = resolvableAsTarget(toResolvable(ref, rest ?? []));
    const allTargets = targets.find(target);
    if (allTargets.length > 1) {
      throw new Error(`Ambiguous reference to target ${JSON.stringify(target)}`);
    }
    if (allTargets.length === 0) {
      throw new Error(`No target found for ${JSON.stringify(target)}`);
    }

    const finalTarget = allTargets[0];
    return `\`${finalTarget.database}.${finalTarget.schema}.${finalTarget.name}\``;
  }
  return ref;
}

export async function compile(modules_path: string, client: IDbClient, action: dataform.IExecutionAction, task: dataform.IExecutionTask,
  jitContextData: google.protobuf.IStruct
): Promise<Uint8Array> {
  if (
    !fs.existsSync(
      path.join(modules_path, "node_modules", "@dataform", "core", "bundle.js")
    )
  ) {
    throw new Error(
      "Could not find a recent installed version of @dataform/core in the project. Check that " +
      "either `dataformCoreVersion` is specified in `workflow_settings.yaml`, or " +
      "`@dataform/core` is specified in `package.json`. If using `package.json`, then run " +
      "`dataform install`."
    );
  }
  function objectFromValue(value: google.protobuf.IValue): Object | number | null | string | boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value.nullValue !== undefined) {
      return null;
    }
    if (value.boolValue !== undefined) {
      return value.boolValue;
    }
    if (value.numberValue !== undefined) {
      return value.numberValue;
    }
    if (value.stringValue !== undefined) {
      return value.stringValue;
    }
    if (value.listValue !== undefined) {
      return value.listValue.values.map(objectFromValue);
    }
    if (value.structValue !== undefined) {
      return Object.fromEntries(Object.entries(value.structValue.fields).map(([key, val]) => [key, objectFromValue(val)]));
    }

    throw new Error(`Unsupported value: ${value}`);
  }
  const data = Object.fromEntries(Object.entries(jitContextData.fields).map(([key, val]) => [key, objectFromValue(val)]));

  const vmIndexFileName = path.resolve(path.join(modules_path, "index.js"));
  return new Promise((resolve) => {
    // First retrieve a compiler function for vm2 to process files.
    const indexGeneratorVm = new NodeVM({
      wrapper: "none",
      require: {
        context: "sandbox",
        root: modules_path,
        external: true,
        builtin: ["ctx"],
        mock: {
          "ctx": {
            client: client,
            ref: ref_impl(action.dependencyTargets),
            request: task.statement,
            return: resolve,
            data: data,
          },
        },
      },
    });
    indexGeneratorVm.run(
      `global.ctx = require("ctx");
       return require("@dataform/core").jitCompiler(ctx.request)`,
      vmIndexFileName
    );
  });
}

export function listenForExecutionRequest() {
  const client = new JitDbClient();
  process.on("message", (request: dataform.IJitExecutionRequest) => {
    try {
      if (request.compile) {
        compile(request.compile.projectDir, client,
          request.compile.action, { statement: request.compile.statement },
          request.compile.jitContextData
        ).then((compiledResult: Uint8Array) => {
          let result = dataform.JitExecutionResponse.decode(Uint8Array.from(compiledResult));
          process.send(result);
        });
        return;
      }

      client.onMessage(request);
    } catch (e) {
      const serializableError = {};
      for (const prop of Object.getOwnPropertyNames(e)) {
        (serializableError as any)[prop] = e[prop];
      }

      process.send(dataform.JitExecutionResponse.create({
        compilationResponse: { compilationError: JSON.stringify(serializableError) },
      }));
    }
  });
}

if (require.main === module) {
  listenForExecutionRequest();
}
