import type { AgentRuntime, ProjectInfo } from "@archcode/agent-core";
import type {
  DashboardAutomation,
  DashboardAutomationInvocation,
  DashboardExecution,
  DashboardProjection,
  DashboardProjectError,
  DashboardRootSession,
  DashboardScope,
  SessionExecutionRecord,
} from "@archcode/protocol";

/**
 * Builds the Dashboard's transient read model from the owning domains.
 *
 * This service deliberately owns no state: Session, Goal, Automation, and
 * Invocation records remain authoritative in their existing stores.
 */
export class DashboardProjectionService {
  readonly #runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.#runtime = runtime;
  }

  async read(scope: DashboardScope): Promise<DashboardProjection> {
    if (scope.kind === "project") {
      const project = await this.#runtime.projectRegistry.get(scope.projectSlug);
      if (project === undefined) throw new Error(`Project not found: ${scope.projectSlug}`);
      return {
        scope,
        ...await this.#readProject(project),
        errors: [],
      };
    }

    const sessions: DashboardRootSession[] = [];
    const automations: DashboardAutomation[] = [];
    const errors: DashboardProjectError[] = [];

    for (const project of await this.#runtime.projectRegistry.list()) {
      try {
        const projection = await this.#readProject(project);
        sessions.push(...projection.sessions);
        automations.push(...projection.automations);
      } catch (error) {
        errors.push(toProjectError(project, error));
      }
    }

    return { scope, sessions, automations, errors };
  }

  async #readProject(project: ProjectInfo): Promise<{
    sessions: DashboardRootSession[];
    automations: DashboardAutomation[];
  }> {
    const [summaries, sourceAutomations] = await Promise.all([
      this.#runtime.listSessions(project.workspaceRoot),
      this.#runtime.listAutomations(project.workspaceRoot),
    ]);
    const roots = summaries.filter((session) => session.parentSessionId === undefined);
    const [sessions, automations] = await Promise.all([
      Promise.all(roots.map(async (summary) => {
        const file = await this.#runtime.getSessionFile(project.workspaceRoot, summary.sessionId);
        if (file.parentSessionId !== undefined || file.rootSessionId !== file.sessionId) {
          throw new Error(`Dashboard root Session is invalid: ${summary.sessionId}`);
        }
        return {
          projectSlug: project.slug,
          projectName: project.name,
          rootSessionId: file.sessionId,
          sessionTitle: file.title,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt,
          ...(file.goal === undefined ? {} : { goal: file.goal }),
          ...(latestExecution(file.executions) === undefined
            ? {}
            : { latestExecution: toDashboardExecution(latestExecution(file.executions)!) }),
        } satisfies DashboardRootSession;
      })),
      Promise.all(sourceAutomations.map(async (automation) => {
        const latest = (await this.#runtime.listAutomationInvocations(project.workspaceRoot, automation.id, 1)).at(-1);
        return {
          projectSlug: project.slug,
          projectName: project.name,
          id: automation.id,
          name: automation.name,
          status: automation.status,
          createdAt: automation.createdAt,
          updatedAt: automation.updatedAt,
          ...(automation.nextFireAt === undefined ? {} : { nextFireAt: automation.nextFireAt }),
          ...(latest === undefined ? {} : { latestInvocation: toDashboardInvocation(latest) }),
        } satisfies DashboardAutomation;
      })),
    ]);

    return { sessions, automations };
  }
}

function latestExecution(executions: readonly SessionExecutionRecord[]): SessionExecutionRecord | undefined {
  return executions.at(-1);
}

function toDashboardExecution(execution: SessionExecutionRecord): DashboardExecution {
  return {
    id: execution.id,
    status: execution.status,
    startedAt: execution.startedAt,
    ...(execution.endedAt === undefined ? {} : { endedAt: execution.endedAt }),
  };
}

function toDashboardInvocation(invocation: {
  id: string;
  status: DashboardAutomationInvocation["status"];
  sessionId?: string;
  createdAt: string;
  completedAt?: string;
}): DashboardAutomationInvocation {
  return {
    id: invocation.id,
    status: invocation.status,
    ...(invocation.sessionId === undefined ? {} : { sessionId: invocation.sessionId }),
    createdAt: invocation.createdAt,
    ...(invocation.completedAt === undefined ? {} : { completedAt: invocation.completedAt }),
  };
}

function toProjectError(project: ProjectInfo, error: unknown): DashboardProjectError {
  return {
    projectSlug: project.slug,
    projectName: project.name,
    message: error instanceof Error ? error.message : String(error),
  };
}
