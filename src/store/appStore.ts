/**
 * 全局应用状态（Zustand）
 *
 * 约定：
 * - `snapshot` 是唯一数据源，UI 从中派生出看板 / 列表 / 任务；
 * - 所有写操作都先调 `api`，成功后再更新本地快照，保证持久化优先；
 * - 选择器只返回稳定引用（对象/数组字段），派生数组请在组件内用 useMemo，
 *   避免 useSyncExternalStore 因每次新建数组而反复渲染。
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { toDateKey } from '@/lib/date';
import {
  degradeSavedViewFieldFilters,
  normalizeSavedViewFilters,
  normalizeSavedViewSort,
} from '@/lib/savedViews';
import type {
  Board,
  BoardPatch,
  CardFieldValueInput,
  BoardSet,
  BoardSetPatch,
  Card,
  CardPatch,
  CreatedBoardWithLists,
  CustomField,
  CustomFieldPatch,
  Goal,
  GoalPatch,
  InboxItem,
  LeavePatch,
  LeaveRecord,
  List,
  ListPatch,
  MemberTenure,
  NewBoardInput,
  NewBoardSetInput,
  NewBoardWithListsInput,
  NewCardInput,
  NewCustomFieldInput,
  NewGoalInput,
  NewLeaveInput,
  NewOvertimeInput,
  NewPerformanceInput,
  NewProjectInput,
  NewProjectMetaInput,
  NewProjectRoleInput,
  NewSavedViewInput,
  NewTeamMemberInput,
  NewTenureInput,
  OvertimePatch,
  OvertimeRecord,
  PerformancePatch,
  PerformanceRecord,
  Project,
  ProjectMetaField,
  ProjectMetaPatch,
  ProjectPatch,
  ProjectRole,
  ProjectRolePatch,
  Snapshot,
  AutomationRule,
  AutomationRulePatch,
  CardActivity,
  NewAutomationRuleInput,
  NewRecurrenceInput,
  NotificationSettings,
  NotificationSettingsInput,
  Recurrence,
  RecurrencePatch,
  RelationType,
  SavedView,
  SavedViewPatch,
  TeamMember,
  TeamMemberPatch,
  TenurePatch,
} from '@/lib/types';

const EMPTY_SNAPSHOT: Snapshot = {
  boards: [],
  lists: [],
  cards: [],
  inbox: [],
  dependencies: [],
  boardSets: [],
  goals: [],
  teamMembers: [],
  overtimeRecords: [],
  performanceRecords: [],
  leaveRecords: [],
  memberTenures: [],
  projects: [],
  projectMetaFields: [],
  projectRoles: [],
  recurrences: [],
  automationRules: [],
  customFields: [],
  cardFieldValues: [],
  savedViews: [],
};
const SEED_FLAG = 'tideline.seeded';

function dateKeyOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export interface AppState {
  snapshot: Snapshot;
  /** 回收站中的任务（软删除），由回收站页面按需加载 */
  trash: Card[];
  loaded: boolean;
  error: string | null;
  init: () => Promise<void>;
  /** 备份恢复后重新拉取快照，并清空按需加载的回收站缓存 */
  reloadSnapshot: () => Promise<void>;
  clearError: () => void;

  createBoard: (input: NewBoardInput) => Promise<Board>;
  /** V0.15.0：一次性创建看板与它的看板列（Excel 导入用） */
  createBoardWithLists: (input: NewBoardWithListsInput) => Promise<CreatedBoardWithLists>;
  updateBoard: (id: string, patch: BoardPatch) => Promise<void>;
  deleteBoard: (id: string) => Promise<void>;
  toggleStar: (id: string) => Promise<void>;

  createBoardSet: (input: NewBoardSetInput) => Promise<BoardSet>;
  updateBoardSet: (id: string, patch: BoardSetPatch) => Promise<void>;
  deleteBoardSet: (id: string) => Promise<void>;

  createGoal: (input: NewGoalInput) => Promise<Goal>;
  updateGoal: (id: string, patch: GoalPatch) => Promise<void>;
  deleteGoal: (id: string) => Promise<void>;

  createTeamMember: (input: NewTeamMemberInput) => Promise<TeamMember>;
  updateTeamMember: (id: string, patch: TeamMemberPatch) => Promise<void>;
  deleteTeamMember: (id: string) => Promise<void>;
  createTenure: (input: NewTenureInput) => Promise<MemberTenure>;
  updateTenure: (id: string, patch: TenurePatch) => Promise<void>;
  deleteTenure: (id: string) => Promise<void>;
  createOvertime: (input: NewOvertimeInput) => Promise<OvertimeRecord>;
  updateOvertime: (id: string, patch: OvertimePatch) => Promise<void>;
  deleteOvertime: (id: string) => Promise<void>;
  createPerformance: (input: NewPerformanceInput) => Promise<PerformanceRecord>;
  updatePerformance: (id: string, patch: PerformancePatch) => Promise<void>;
  deletePerformance: (id: string) => Promise<void>;
  /** 请假记录（V0.16.0） */
  createLeave: (input: NewLeaveInput) => Promise<LeaveRecord>;
  updateLeave: (id: string, patch: LeavePatch) => Promise<void>;
  deleteLeave: (id: string) => Promise<void>;

  createProject: (input: NewProjectInput) => Promise<Project>;
  updateProject: (id: string, patch: ProjectPatch) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createProjectMeta: (input: NewProjectMetaInput) => Promise<ProjectMetaField>;
  updateProjectMeta: (id: string, patch: ProjectMetaPatch) => Promise<void>;
  deleteProjectMeta: (id: string) => Promise<void>;
  createProjectRole: (input: NewProjectRoleInput) => Promise<ProjectRole>;
  updateProjectRole: (id: string, patch: ProjectRolePatch) => Promise<void>;
  deleteProjectRole: (id: string) => Promise<void>;

  createList: (boardId: string, title: string) => Promise<List>;
  updateList: (id: string, patch: ListPatch) => Promise<void>;
  deleteList: (id: string) => Promise<void>;

  createCard: (input: NewCardInput) => Promise<Card>;
  updateCard: (id: string, patch: CardPatch) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  moveCard: (cardId: string, toListId: string, toIndex: number) => Promise<void>;
  /** 整体替换某张任务的关系列表（V0.4 起为前置任务，V0.12 起带类型） */
  setDependencies: (
    cardId: string,
    dependsOn: string[],
    relationTypes?: RelationType[],
  ) => Promise<void>;

  /** 看板内批量操作（V0.4）：顺序写入后刷新快照 */
  bulkMoveCards: (cardIds: string[], toListId: string) => Promise<void>;
  bulkDeleteCards: (cardIds: string[]) => Promise<void>;
  bulkUpdateCards: (cardIds: string[], patch: CardPatch) => Promise<void>;

  loadTrash: () => Promise<void>;
  restoreCard: (id: string) => Promise<void>;
  purgeCard: (id: string) => Promise<void>;
  emptyTrash: () => Promise<void>;

  addInbox: (content: string) => Promise<void>;
  deleteInbox: (id: string) => Promise<void>;
  convertInbox: (id: string, boardId: string, listId?: string) => Promise<Card>;

  /* ---------- 自动化与提醒（V0.11） ---------- */
  /** 某张任务的最近活动（倒序），由任务详情按需加载 */
  loadCardActivity: (cardId: string) => Promise<CardActivity[]>;
  /** 新建重复任务配置 */
  createRecurrence: (input: NewRecurrenceInput) => Promise<Recurrence>;
  /** 修改重复任务配置 */
  updateRecurrence: (id: string, patch: RecurrencePatch) => Promise<void>;
  /** 删除重复任务配置 */
  deleteRecurrence: (id: string) => Promise<void>;
  /** 新建本地规则（默认关闭） */
  createAutomationRule: (input: NewAutomationRuleInput) => Promise<AutomationRule>;
  /** 修改本地规则 */
  updateAutomationRule: (id: string, patch: AutomationRulePatch) => Promise<void>;
  /** 删除本地规则 */
  deleteAutomationRule: (id: string) => Promise<void>;
  /** 读取提醒设置 */
  loadNotificationSettings: () => Promise<NotificationSettings>;
  /** 更新提醒设置 */
  updateNotificationSettings: (patch: NotificationSettingsInput) => Promise<void>;

  /* ---------- 自定义字段（V0.13.0） ---------- */
  /** 新建自定义字段（按看板隔离） */
  createCustomField: (input: NewCustomFieldInput) => Promise<CustomField>;
  /** 修改自定义字段 */
  updateCustomField: (id: string, patch: CustomFieldPatch) => Promise<void>;
  /** 删除自定义字段（连带清理取值） */
  deleteCustomField: (id: string) => Promise<void>;
  /** 设置某张任务在一组字段上的取值 */
  setCardFieldValues: (cardId: string, values: CardFieldValueInput[]) => Promise<void>;

  /* ---------- 保存的筛选视图（V0.13.1） ---------- */
  /** 新建保存视图 */
  createSavedView: (input: NewSavedViewInput) => Promise<SavedView>;
  /** 修改保存视图 */
  updateSavedView: (id: string, patch: SavedViewPatch) => Promise<void>;
  /** 删除保存视图 */
  deleteSavedView: (id: string) => Promise<void>;
}

/**
 * 归一化快照里的保存视图：后端存的排序键与筛选条件统一成前端形状。
 * 旧数据、脏数据与后端默认值都在这里收口，界面层拿到的永远是规范结构。
 */
function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  if (!snapshot.savedViews || snapshot.savedViews.length === 0) return snapshot;
  return {
    ...snapshot,
    savedViews: snapshot.savedViews.map((view) => ({
      ...view,
      filters: degradeSavedViewFieldFilters(
        normalizeSavedViewFilters(view.filters),
        snapshot.customFields,
      ),
      sort: normalizeSavedViewSort(view.sort),
    })),
  };
}

export const useAppStore = create<AppState>((set, get) => {
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    set({ error: message });
    throw error;
  };

  return {
    snapshot: EMPTY_SNAPSHOT,
    trash: [],
    loaded: false,
    error: null,

    clearError: () => set({ error: null }),

    init: async () => {
      if (get().loaded) return;
      try {
        const snapshot = await api.getSnapshot();
        set({ snapshot: normalizeSnapshot(snapshot), loaded: true });
        const seeded = await seedDemoIfNeeded();
        if (seeded) set({ snapshot: normalizeSnapshot(await api.getSnapshot()) });
      } catch (error) {
        fail(error);
      }
    },

    reloadSnapshot: async () => {
      try {
        const snapshot = await api.getSnapshot();
        set({ snapshot: normalizeSnapshot(snapshot), trash: [] });
      } catch (error) {
        fail(error);
      }
    },

    createBoard: async (input) => {
      try {
        const board = await api.createBoard(input);
        // 新看板自带三条默认列表，避免用户面对空白画布
        const defaults = ['待办', '进行中', '已完成'];
        for (const title of defaults) {
          await api.createList({ boardId: board.id, title });
        }
        const snapshot = await api.getSnapshot();
        set({ snapshot });
        return board;
      } catch (error) {
        return fail(error);
      }
    },

    // V0.15.0：导入 Excel 时建看板 + 看板列，一步到位
    createBoardWithLists: async (input) => {
      try {
        const created = await api.createBoardWithLists(input);
        const snapshot = await api.getSnapshot();
        set({ snapshot });
        return created;
      } catch (error) {
        return fail(error);
      }
    },

    updateBoard: async (id, patch) => {
      try {
        const board = await api.updateBoard({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            boards: state.snapshot.boards.map((b) => (b.id === id ? board : b)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteBoard: async (id) => {
      try {
        await api.deleteBoard({ id });
        set((state) => {
          const removedListIds = new Set(
            state.snapshot.lists.filter((l) => l.boardId === id).map((l) => l.id),
          );
          const removedCardIds = new Set(
            state.snapshot.cards
              .filter((c) => removedListIds.has(c.listId) || c.boardId === id)
              .map((c) => c.id),
          );
          return {
            snapshot: {
              boards: state.snapshot.boards.filter((b) => b.id !== id),
              lists: state.snapshot.lists.filter((l) => l.boardId !== id),
              cards: state.snapshot.cards.filter((c) => !removedListIds.has(c.listId)),
              inbox: state.snapshot.inbox,
              dependencies: state.snapshot.dependencies.filter(
                (d) => !removedCardIds.has(d.cardId) && !removedCardIds.has(d.dependsOnCardId),
              ),
              boardSets: state.snapshot.boardSets.map((set) =>
                set.boardIds.includes(id)
                  ? { ...set, boardIds: set.boardIds.filter((boardId) => boardId !== id) }
                  : set,
              ),
              goals: state.snapshot.goals.map((goal) => ({
                ...goal,
                cardIds: goal.cardIds.filter((cardId) => !removedCardIds.has(cardId)),
              })),
              teamMembers: state.snapshot.teamMembers,
              overtimeRecords: state.snapshot.overtimeRecords,
              performanceRecords: state.snapshot.performanceRecords,
              leaveRecords: state.snapshot.leaveRecords,
              memberTenures: state.snapshot.memberTenures,
              projects: state.snapshot.projects,
              projectMetaFields: state.snapshot.projectMetaFields,
              projectRoles: state.snapshot.projectRoles,
              recurrences: state.snapshot.recurrences.filter(
                (item) => !removedCardIds.has(item.cardId),
              ),
              automationRules: state.snapshot.automationRules,
              savedViews: state.snapshot.savedViews.filter((item) => item.boardId !== id),
              customFields: state.snapshot.customFields.filter(
                (item) => item.boardId !== id,
              ),
              cardFieldValues: state.snapshot.cardFieldValues.filter(
                (value) => !removedCardIds.has(value.cardId),
              ),
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    createBoardSet: async (input) => {
      try {
        const boardSet = await api.createBoardSet(input);
        set((state) => ({
          snapshot: { ...state.snapshot, boardSets: [...state.snapshot.boardSets, boardSet] },
        }));
        return boardSet;
      } catch (error) {
        return fail(error);
      }
    },

    updateBoardSet: async (id, patch) => {
      try {
        const boardSet = await api.updateBoardSet({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            boardSets: state.snapshot.boardSets.map((item) => (item.id === id ? boardSet : item)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteBoardSet: async (id) => {
      try {
        await api.deleteBoardSet({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            boardSets: state.snapshot.boardSets.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createGoal: async (input) => {
      try {
        const goal = await api.createGoal(input);
        set((state) => ({
          snapshot: { ...state.snapshot, goals: [...state.snapshot.goals, goal] },
        }));
        return goal;
      } catch (error) {
        return fail(error);
      }
    },

    updateGoal: async (id, patch) => {
      try {
        const goal = await api.updateGoal({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            goals: state.snapshot.goals.map((item) => (item.id === id ? goal : item)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteGoal: async (id) => {
      try {
        await api.deleteGoal({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            goals: state.snapshot.goals
              .filter((item) => item.id !== id)
              .map((item) => (item.parentId === id ? { ...item, parentId: null } : item)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createTeamMember: async (input) => {
      try {
        const member = await api.createTeamMember(input);
        await get().reloadSnapshot();
        return member;
      } catch (error) {
        return fail(error);
      }
    },

    updateTeamMember: async (id, patch) => {
      try {
        await api.updateTeamMember({ id, patch });
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    deleteTeamMember: async (id) => {
      try {
        await api.deleteTeamMember({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            teamMembers: state.snapshot.teamMembers.filter((item) => item.id !== id),
            memberTenures: state.snapshot.memberTenures.filter(
              (tenure) => tenure.memberId !== id,
            ),
            overtimeRecords: state.snapshot.overtimeRecords.filter(
              (item) => item.memberId !== id,
            ),
            performanceRecords: state.snapshot.performanceRecords.filter(
              (item) => item.memberId !== id,
            ),
            leaveRecords: state.snapshot.leaveRecords.filter(
              (item) => item.memberId !== id,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createTenure: async (input) => {
      try {
        const tenure = await api.createTenure(input);
        await get().reloadSnapshot();
        return tenure;
      } catch (error) {
        return fail(error);
      }
    },

    updateTenure: async (id, patch) => {
      try {
        await api.updateTenure({ id, patch });
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    deleteTenure: async (id) => {
      try {
        await api.deleteTenure({ id });
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    createOvertime: async (input) => {
      try {
        const record = await api.createOvertime(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            overtimeRecords: [record, ...state.snapshot.overtimeRecords],
          },
        }));
        return record;
      } catch (error) {
        return fail(error);
      }
    },

    updateOvertime: async (id, patch) => {
      try {
        const record = await api.updateOvertime({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            overtimeRecords: state.snapshot.overtimeRecords.map((item) =>
              item.id === id ? record : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteOvertime: async (id) => {
      try {
        await api.deleteOvertime({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            overtimeRecords: state.snapshot.overtimeRecords.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createPerformance: async (input) => {
      try {
        const record = await api.createPerformance(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            performanceRecords: [record, ...state.snapshot.performanceRecords],
          },
        }));
        return record;
      } catch (error) {
        return fail(error);
      }
    },

    updatePerformance: async (id, patch) => {
      try {
        const record = await api.updatePerformance({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            performanceRecords: state.snapshot.performanceRecords.map((item) =>
              item.id === id ? record : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deletePerformance: async (id) => {
      try {
        await api.deletePerformance({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            performanceRecords: state.snapshot.performanceRecords.filter(
              (item) => item.id !== id,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createLeave: async (input) => {
      try {
        const record = await api.createLeave(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            leaveRecords: [record, ...state.snapshot.leaveRecords],
          },
        }));
        return record;
      } catch (error) {
        return fail(error);
      }
    },

    updateLeave: async (id, patch) => {
      try {
        const record = await api.updateLeave({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            leaveRecords: state.snapshot.leaveRecords.map((item) =>
              item.id === id ? record : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteLeave: async (id) => {
      try {
        await api.deleteLeave({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            leaveRecords: state.snapshot.leaveRecords.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createProject: async (input) => {
      try {
        const project = await api.createProject(input);
        await get().reloadSnapshot();
        return project;
      } catch (error) {
        return fail(error);
      }
    },

    updateProject: async (id, patch) => {
      try {
        const project = await api.updateProject({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projects: state.snapshot.projects.map((item) => (item.id === id ? project : item)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteProject: async (id) => {
      try {
        await api.deleteProject({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projects: state.snapshot.projects.filter((item) => item.id !== id),
            projectRoles: state.snapshot.projectRoles.filter((role) => role.projectId !== id),
            projectMetaFields: state.snapshot.projectMetaFields.filter(
              (field) => field.projectId !== id,
            ),
            teamMembers: state.snapshot.teamMembers.filter((member) => member.projectId !== id),
            memberTenures: state.snapshot.memberTenures.filter(
              (tenure) => tenure.projectId !== id,
            ),
            overtimeRecords: state.snapshot.overtimeRecords.filter(
              (record) => record.projectId !== id,
            ),
            performanceRecords: state.snapshot.performanceRecords.filter(
              (record) => record.projectId !== id,
            ),
            leaveRecords: state.snapshot.leaveRecords.filter(
              (record) => record.projectId !== id,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createProjectMeta: async (input) => {
      try {
        const field = await api.createProjectMeta(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectMetaFields: [...state.snapshot.projectMetaFields, field],
          },
        }));
        return field;
      } catch (error) {
        return fail(error);
      }
    },

    updateProjectMeta: async (id, patch) => {
      try {
        const field = await api.updateProjectMeta({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectMetaFields: state.snapshot.projectMetaFields.map((item) =>
              item.id === id ? field : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteProjectMeta: async (id) => {
      try {
        await api.deleteProjectMeta({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectMetaFields: state.snapshot.projectMetaFields.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createProjectRole: async (input) => {
      try {
        const role = await api.createProjectRole(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectRoles: [...state.snapshot.projectRoles, role],
          },
        }));
        return role;
      } catch (error) {
        return fail(error);
      }
    },

    updateProjectRole: async (id, patch) => {
      try {
        const role = await api.updateProjectRole({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectRoles: state.snapshot.projectRoles.map((item) =>
              item.id === id ? role : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteProjectRole: async (id) => {
      try {
        await api.deleteProjectRole({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            projectRoles: state.snapshot.projectRoles.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    toggleStar: async (id) => {
      const board = get().snapshot.boards.find((b) => b.id === id);
      if (!board) return;
      await get().updateBoard(id, { starred: !board.starred });
    },

    createList: async (boardId, title) => {
      try {
        const list = await api.createList({ boardId, title });
        set((state) => ({
          snapshot: { ...state.snapshot, lists: [...state.snapshot.lists, list] },
        }));
        return list;
      } catch (error) {
        return fail(error);
      }
    },

    updateList: async (id, patch) => {
      try {
        const list = await api.updateList({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            lists: state.snapshot.lists.map((l) => (l.id === id ? list : l)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteList: async (id) => {
      try {
        await api.deleteList({ id });
        set((state) => {
          const removedCardIds = new Set(
            state.snapshot.cards.filter((c) => c.listId === id).map((c) => c.id),
          );
          return {
            snapshot: {
              ...state.snapshot,
              lists: state.snapshot.lists.filter((l) => l.id !== id),
              cards: state.snapshot.cards.filter((c) => c.listId !== id),
              dependencies: state.snapshot.dependencies.filter(
                (d) => !removedCardIds.has(d.cardId) && !removedCardIds.has(d.dependsOnCardId),
              ),
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    createCard: async (input) => {
      try {
        const card = await api.createCard(input);
        set((state) => ({
          snapshot: { ...state.snapshot, cards: [...state.snapshot.cards, card] },
        }));
        return card;
      } catch (error) {
        return fail(error);
      }
    },

    updateCard: async (id, patch) => {
      try {
        const card = await api.updateCard({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: state.snapshot.cards.map((c) => (c.id === id ? card : c)),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteCard: async (id) => {
      try {
        await api.deleteCard({ id });
        // V0.14.0：删除主任务会连带整棵子树，重新拉取快照避免残留幽灵子任务。
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    // ---------- 回收站：软删除任务 ----------
    loadTrash: async () => {
      try {
        const items = await api.getTrash();
        set({ trash: items });
      } catch (error) {
        fail(error);
      }
    },

    restoreCard: async (id) => {
      try {
        await api.restoreCard({ id });
        // V0.14.0：恢复会连带祖先链与后代，重新拉取快照与回收站保持一致。
        await get().reloadSnapshot();
        await get().loadTrash();
      } catch (error) {
        fail(error);
      }
    },

    purgeCard: async (id) => {
      try {
        await api.purgeCard({ id });
        await get().reloadSnapshot();
        await get().loadTrash();
      } catch (error) {
        fail(error);
      }
    },

    emptyTrash: async () => {
      try {
        await api.emptyTrash();
        await get().reloadSnapshot();
        await get().loadTrash();
      } catch (error) {
        fail(error);
      }
    },

    moveCard: async (cardId, toListId, toIndex) => {
      try {
        const moved = await api.moveCard({ cardId, toListId, toIndex });
        set((state) => {
          const others = state.snapshot.cards.filter((c) => c.id !== cardId);
          const target = others
            .filter((c) => c.listId === toListId)
            .sort((a, b) => a.position - b.position);
          const rest = others.filter((c) => c.listId !== toListId);
          const nextTarget = [...target];
          nextTarget.splice(Math.max(0, Math.min(toIndex, nextTarget.length)), 0, moved);
          return {
            snapshot: {
              ...state.snapshot,
              cards: [...rest, ...nextTarget.map((card, index) => ({ ...card, position: index }))],
            },
          };
        });
      } catch (error) {
        fail(error);
      }
    },

    setDependencies: async (cardId, dependsOn, relationTypes) => {
      try {
        const dependencies = await api.setCardDependencies({
          cardId,
          dependsOn,
          relationTypes,
        });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            dependencies: [
              ...state.snapshot.dependencies.filter((dependency) => dependency.cardId !== cardId),
              ...dependencies,
            ],
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    bulkMoveCards: async (cardIds, toListId) => {
      try {
        const existingTargetCount = get().snapshot.cards.filter(
          (card) => card.listId === toListId && !cardIds.includes(card.id),
        ).length;
        for (let index = 0; index < cardIds.length; index += 1) {
          await api.moveCard({
            cardId: cardIds[index],
            toListId,
            toIndex: existingTargetCount + index,
          });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    bulkDeleteCards: async (cardIds) => {
      try {
        for (const cardId of cardIds) {
          await api.deleteCard({ id: cardId });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    bulkUpdateCards: async (cardIds, patch) => {
      try {
        for (const cardId of cardIds) {
          await api.updateCard({ id: cardId, patch });
        }
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    addInbox: async (content) => {
      try {
        const item = await api.addInboxItem({ content });
        set((state) => ({
          snapshot: { ...state.snapshot, inbox: [item, ...state.snapshot.inbox] },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteInbox: async (id) => {
      try {
        await api.deleteInboxItem({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            inbox: state.snapshot.inbox.filter((item: InboxItem) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    convertInbox: async (id, boardId, listId) => {
      try {
        const card = await api.convertInboxItem({ id, boardId, listId });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            cards: [...state.snapshot.cards, card],
            inbox: state.snapshot.inbox.filter((item) => item.id !== id),
          },
        }));
        return card;
      } catch (error) {
        return fail(error);
      }
    },

    /* ---------- 自动化与提醒（V0.11） ---------- */

    loadCardActivity: async (cardId) => {
      try {
        return await api.getCardActivity({ id: cardId });
      } catch (error) {
        return fail(error);
      }
    },

    createRecurrence: async (input) => {
      try {
        const recurrence = await api.createRecurrence(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            recurrences: [
              ...state.snapshot.recurrences.filter((item) => item.cardId !== input.cardId),
              recurrence,
            ],
          },
        }));
        return recurrence;
      } catch (error) {
        return fail(error);
      }
    },

    updateRecurrence: async (id, patch) => {
      try {
        const recurrence = await api.updateRecurrence({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            recurrences: state.snapshot.recurrences.map((item) =>
              item.id === id ? recurrence : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteRecurrence: async (id) => {
      try {
        await api.deleteRecurrence({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            recurrences: state.snapshot.recurrences.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    createAutomationRule: async (input) => {
      try {
        const rule = await api.createAutomationRule(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            automationRules: [...state.snapshot.automationRules, rule],
          },
        }));
        return rule;
      } catch (error) {
        return fail(error);
      }
    },

    updateAutomationRule: async (id, patch) => {
      try {
        const rule = await api.updateAutomationRule({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            automationRules: state.snapshot.automationRules.map((item) =>
              item.id === id ? rule : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteAutomationRule: async (id) => {
      try {
        await api.deleteAutomationRule({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            automationRules: state.snapshot.automationRules.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    loadNotificationSettings: async () => {
      try {
        return await api.getNotificationSettings();
      } catch (error) {
        return fail(error);
      }
    },

    updateNotificationSettings: async (patch) => {
      try {
        await api.setNotificationSettings(patch);
      } catch (error) {
        fail(error);
      }
    },

    /* ---------- 自定义字段（V0.13.0） ---------- */

    createCustomField: async (input) => {
      try {
        const field = await api.createCustomField(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            customFields: [...state.snapshot.customFields, field],
          },
        }));
        return field;
      } catch (error) {
        return fail(error);
      }
    },

    updateCustomField: async (id, patch) => {
      try {
        const field = await api.updateCustomField({ id, patch });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            customFields: state.snapshot.customFields.map((item) =>
              item.id === id ? field : item,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    deleteCustomField: async (id) => {
      try {
        await api.deleteCustomField({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            customFields: state.snapshot.customFields.filter((item) => item.id !== id),
            cardFieldValues: state.snapshot.cardFieldValues.filter(
              (value) => value.fieldId !== id,
            ),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },

    setCardFieldValues: async (cardId, values) => {
      try {
        await api.setCardFieldValues({ cardId, values });
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    /* ---------- 保存的筛选视图（V0.13.1） ---------- */

    createSavedView: async (input) => {
      try {
        const view = await api.createSavedView(input);
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            savedViews: [...state.snapshot.savedViews, view],
          },
        }));
        return view;
      } catch (error) {
        return fail(error);
      }
    },

    updateSavedView: async (id, patch) => {
      try {
        await api.updateSavedView({ id, patch });
        await get().reloadSnapshot();
      } catch (error) {
        fail(error);
      }
    },

    deleteSavedView: async (id) => {
      try {
        await api.deleteSavedView({ id });
        set((state) => ({
          snapshot: {
            ...state.snapshot,
            savedViews: state.snapshot.savedViews.filter((item) => item.id !== id),
          },
        }));
      } catch (error) {
        fail(error);
      }
    },
  };
});

/** 便捷选择器：只订阅快照本身，派生数据请在组件内 useMemo */
export const useSnapshot = (): Snapshot => useAppStore((state) => state.snapshot);

export function useBoard(boardId: string | undefined): Board | undefined {
  return useAppStore((state) =>
    boardId ? state.snapshot.boards.find((board) => board.id === boardId) : undefined,
  );
}

/**
 * 首次启动写入一套演示数据：
 * 让用户打开应用就能看到星标 / 最近 / 我的任务 / 收件箱的真实形态。
 * 用户清空后不再重播（用 seeded 标记控制）。
 */
async function seedDemoIfNeeded(): Promise<boolean> {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(SEED_FLAG)) return false;
    if (typeof localStorage !== 'undefined') localStorage.setItem(SEED_FLAG, '1');
  } catch {
    return false;
  }

  try {
    const snapshot = await api.getSnapshot();
    if (snapshot.boards.length > 0) return false;

    /** V0.14.0：演示数据里的子任务是真实卡片，先建父任务再逐条挂子任务。 */
    const addSubtasks = async (
      parent: Card,
      items: Array<{ title: string; done?: boolean }>,
    ) => {
      for (const item of items) {
        const child = await api.createCard({
          boardId: parent.boardId,
          listId: parent.listId,
          parentCardId: parent.id,
          title: item.title,
        });
        if (item.done) {
          await api.updateCard({ id: child.id, patch: { completed: true } });
        }
      }
    };

    const product = await api.createBoard({
      title: '产品发布 · V0.2',
      color: 'blue',
      description: '把潮线第二版做出来：表格 + 甘特 + 更完整的任务抽屉。',
    });
    await api.updateBoard({ id: product.id, patch: { starred: true } });

    const productTodo = await api.createList({ boardId: product.id, title: '待办' });
    const productDoing = await api.createList({ boardId: product.id, title: '进行中' });
    const productDone = await api.createList({ boardId: product.id, title: '已完成' });

    const dbCard = await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '补充本地数据库索引',
      description:
        '为 `cards.list_id`、`cards.due_date` 建索引，数据量大时查询更稳。\n\n验收标准：\n- 10 万条任务下列表查询 < 50ms\n- 迁移脚本可重复执行',
      startDate: dateKeyOffset(-5),
      dueDate: dateKeyOffset(-2),
      priority: 'high',
      labels: ['研发', '性能'],
    });
    await addSubtasks(dbCard, [
      { title: '排查慢查询', done: true },
      { title: '写索引迁移脚本' },
      { title: '压测验证' },
    ]);
    const docCard = await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '编写 V0.2 发布说明',
      description: '整理 V0.2 的功能清单与已知限制，发布到 GitHub Release。',
      startDate: dateKeyOffset(1),
      dueDate: dateKeyOffset(6),
      priority: 'medium',
      labels: ['文档'],
    });
    await addSubtasks(docCard, [
      { title: '整理功能清单', done: true },
      { title: '补截图与动图' },
    ]);
    await api.createCard({
      boardId: product.id,
      listId: productTodo.id,
      title: '补充导出/备份入口',
      description: '把 SQLite 文件一键复制到用户选择的位置。',
      startDate: dateKeyOffset(7),
      dueDate: dateKeyOffset(12),
      labels: ['研发'],
    });
    const tableCard = await api.createCard({
      boardId: product.id,
      listId: productDoing.id,
      title: '实现表格视图',
      description: '表格视图带行内编辑与筛选排序，和看板共用同一套任务数据。',
      startDate: dateKeyOffset(-2),
      dueDate: dateKeyOffset(0),
      priority: 'high',
      labels: ['研发', '体验'],
    });
    await addSubtasks(tableCard, [
      { title: '字段表格', done: true },
      { title: '行内编辑', done: true },
      { title: '筛选与排序' },
    ]);
    const sqliteCard = await api.createCard({
      boardId: product.id,
      listId: productDoing.id,
      title: '接入 SQLite 持久化',
      description: 'Rust 侧用 rusqlite 建库，前端启动时加载全量快照。',
      startDate: dateKeyOffset(-1),
      dueDate: dateKeyOffset(2),
      priority: 'medium',
      labels: ['研发', '数据'],
    });
    await addSubtasks(sqliteCard, [{ title: '建表与迁移', done: true }]);
    const archCard = await api.createCard({
      boardId: product.id,
      listId: productDone.id,
      title: '确定技术选型',
      description: 'Tauri 2 + React + TypeScript，本地优先。',
      priority: 'low',
      labels: ['决策'],
    });
    await addSubtasks(archCard, [{ title: '对比 Electron / Tauri', done: true }]);
    const doneCard = await api.createCard({
      boardId: product.id,
      listId: productDone.id,
      title: '搭建工程骨架',
      description: 'Vite + React + TypeScript + 设计令牌。',
    });
    await api.updateCard({ id: doneCard.id, patch: { completed: true } });

    const life = await api.createBoard({
      title: '生活与灵感',
      color: 'amber',
      description: '工作之外的输入与充电。',
    });
    const lifeThisWeek = await api.createList({ boardId: life.id, title: '本周想做' });
    const lifeIdeas = await api.createList({ boardId: life.id, title: '灵感池' });
    await api.createCard({
      boardId: life.id,
      listId: lifeThisWeek.id,
      title: '读完《深度工作》第三章',
      dueDate: dateKeyOffset(3),
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeThisWeek.id,
      title: '周末骑行 30 公里',
      dueDate: dateKeyOffset(4),
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeIdeas.id,
      title: '做一个潮汐白噪音页面',
      description: '低饱和配色 + 真实潮汐数据，作为潮线的彩蛋页面。',
    });
    await api.createCard({
      boardId: life.id,
      listId: lifeIdeas.id,
      title: '收集独立开发者访谈',
    });

    const content = await api.createBoard({
      title: '内容创作计划',
      color: 'violet',
      description: '选题、写作、发布，把想法稳定地变成内容。',
    });
    const contentIdeas = await api.createList({ boardId: content.id, title: '选题池' });
    const contentWriting = await api.createList({ boardId: content.id, title: '写作中' });
    const contentDone = await api.createList({ boardId: content.id, title: '已发布' });
    await api.createCard({
      boardId: content.id,
      listId: contentIdeas.id,
      title: '《本地优先软件为什么值得做》',
      dueDate: dateKeyOffset(9),
      priority: 'medium',
    });
    await api.createCard({
      boardId: content.id,
      listId: contentIdeas.id,
      title: '整理 10 个看板工具的使用场景',
    });
    const postCard = await api.createCard({
      boardId: content.id,
      listId: contentWriting.id,
      title: '写一篇 V0.2 开发复盘',
      description: '记录从看板到表格、甘特两版视图的取舍：为什么先不做协作。',
      startDate: dateKeyOffset(0),
      dueDate: dateKeyOffset(5),
      priority: 'high',
      labels: ['写作'],
    });
    await addSubtasks(postCard, [
      { title: '列提纲', done: true },
      { title: '写完初稿' },
      { title: '配图与校对' },
    ]);
    const published = await api.createCard({
      boardId: content.id,
      listId: contentDone.id,
      title: '产品定位与差异化梳理',
    });
    await api.updateCard({ id: published.id, patch: { completed: true } });

    const reading = await api.createBoard({
      title: '读书与学习',
      color: 'green',
      description: '慢慢读，认真记。',
    });
    const readingNow = await api.createList({ boardId: reading.id, title: '在读' });
    const readingList = await api.createList({ boardId: reading.id, title: '书单' });
    await api.createCard({
      boardId: reading.id,
      listId: readingNow.id,
      title: '《卡片笔记写作法》第 2 章',
      dueDate: dateKeyOffset(7),
    });
    await api.createCard({
      boardId: reading.id,
      listId: readingList.id,
      title: '《Rust 程序设计语言》第 4 章',
    });

    await api.addInboxItem({ content: '研究 Tauri 2 自动更新与签名方案' });
    await api.addInboxItem({ content: '收集竞品定价页截图，整理差异化卖点' });
    await api.addInboxItem({ content: '周五复盘会前整理本周数据' });
    return true;
  } catch (error) {
    console.warn('演示数据写入失败（不影响使用）', error);
    return false;
  }
}
