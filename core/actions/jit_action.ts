import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "df/common/protos";
import { ActionBuilder } from "df/core/actions";
import { Resolvable } from "df/core/contextables";
import * as Path from "df/core/path";
import { Session } from "df/core/session";
import {
    actionConfigToCompiledGraphTarget,
    checkAssertionsForDependency,
    configTargetToCompiledGraphTarget,
    resolveActionsConfigFilename
} from "df/core/utils";
import { dataform } from "df/protos/ts";

function verifyConfig(unverifiedConfig: any): dataform.ActionConfig.JitActionConfig {
    if (typeof unverifiedConfig?.type === "string") {
        unverifiedConfig.type = dataform.ActionConfig.JitActionConfig.ActionType[
            unverifiedConfig.type.toUpperCase() as keyof typeof dataform.ActionConfig.JitActionConfig.ActionType
        ];
    }
    return verifyObjectMatchesProto(
        dataform.ActionConfig.JitActionConfig,
        unverifiedConfig,
        VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
}

export class JitAction extends ActionBuilder<dataform.JitAction> {
    /**
   * @hidden If true, adds the inline assertions of dependencies as direct dependencies for this
   * action.
   */
    public dependOnDependencyAssertions: boolean = false;

    private proto = dataform.JitAction.create();

    constructor(session?: Session, unverifiedConfig?: any, configPath?: string) {
        super(session);

        const config = verifyConfig(unverifiedConfig);
        if (!config.name) {
            config.name = Path.basename(config.filename);
        }
        const target = actionConfigToCompiledGraphTarget(config);
        config.filename = resolveActionsConfigFilename(config.filename, configPath);

        this.proto.target = this.applySessionToTarget(target, session.projectConfig, config.filename, {
            validateTarget: true
        });
        this.proto.canonicalTarget = this.applySessionToTarget(target, session.canonicalProjectConfig);
        this.proto.tags = config.tags;
        this.dependOnDependencyAssertions = config.dependOnDependencyAssertions;
        if (config.dependencyTargets) {
            this.dependencies(
                config.dependencyTargets.map(dependencyTarget =>
                    configTargetToCompiledGraphTarget(dataform.ActionConfig.Target.create(dependencyTarget))
                )
            );
        }
        this.proto.fileName = config.filename;
        if (config.disabled) {
            this.proto.disabled = config.disabled;
        }
        switch (config.type) {
            case dataform.ActionConfig.JitActionConfig.ActionType.UNSPECIFIED:
            case dataform.ActionConfig.JitActionConfig.ActionType.OPERATION:
                this.proto.enumType = dataform.JitAction.JitActionType.OPERATION;
                break;
            case dataform.ActionConfig.JitActionConfig.ActionType.TABLE:
                this.proto.enumType = dataform.JitAction.JitActionType.TABLE;
                break;
            case dataform.ActionConfig.JitActionConfig.ActionType.VIEW:
                this.proto.enumType = dataform.JitAction.JitActionType.VIEW;
                break;
            default:
                throw new Error(`Unsupported JIT action type: ${this.proto.enumType}`);
        }
    }

    /** @hidden */
    public getFileName(): string {
        return this.proto.fileName;
    }

    /** @hidden */
    public getTarget(): dataform.Target {
        return dataform.Target.create(this.proto.target);
    }

    /** @hidden */
    public compile(): dataform.JitAction {
        if (!this.proto.jitAction) {
            throw new Error(`Missing "action" specification in JIT action config of ${this.proto.fileName}`);
        }
        return verifyObjectMatchesProto(
            dataform.JitAction,
            this.proto,
            VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
        );
    }

    /** @hidden */
    public dependencies(value: Resolvable | Resolvable[]) {
        const newDependencies = Array.isArray(value) ? value : [value];
        newDependencies.forEach(resolvable => {
            const dependencyTarget = checkAssertionsForDependency(this, resolvable);
            if (!!dependencyTarget) {
                this.proto.dependencyTargets.push(dependencyTarget);
            }
        });
        return this;
    }

    /** Set JIT action content. */
    public action(jit_action: string) {
        this.proto.jitAction = jit_action;
        return this;
    }
}
