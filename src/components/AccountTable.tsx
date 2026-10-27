import { useRef, useState, type KeyboardEvent } from "react";
import {
  closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { reorderAccount } from "../configMerge";
import { PROVIDER_KINDS, type AccountConfig } from "../types";

interface Props {
  accounts: AccountConfig[];
  onReorder: (accounts: AccountConfig[]) => void;
  onToggle: (id: string) => void;
  onEdit: (account: AccountConfig) => void;
  onDuplicate: (account: AccountConfig) => void;
  onRemove: (id: string) => void;
}

function Grip() {
  return (
    <svg width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true">
      {[5, 11].flatMap((cx) => [5, 10, 15].map((cy) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.35" />))}
    </svg>
  );
}

function AccountRow({ account: a, index, onlyAccount, dropPosition, onToggle, onEdit, onDuplicate, onRemove }:
  Omit<Props, "accounts" | "onReorder"> & {
    account: AccountConfig; index: number; onlyAccount: boolean; dropPosition?: "before" | "after";
  }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: a.id, disabled: onlyAccount, transition: { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
  });
  const name = a.name || "未命名账号";
  const kind = PROVIDER_KINDS.find((item) => item.value === a.kind);
  const auth = a.token ? "Token" : a.apiKey ? "API Key" : a.username ? "账号密码" : a.custom ? "自定义" : null;
  const onRowKeyDown = (e: KeyboardEvent<HTMLTableRowElement>) => {
    // Controls, including the keyboard drag handle, own their key events.
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll("tr") ?? []);
      const position = rows.indexOf(e.currentTarget);
      rows[position + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onEdit(a);
    }
  };
  return (
    <tr
      ref={setNodeRef}
      className={["account-sort-row", !a.enabled && "disabled-row", isDragging && "account-row-dragging", dropPosition && `account-drop-${dropPosition}`].filter(Boolean).join(" ")}
      style={{ transform: CSS.Translate.toString(transform), transition, position: "relative", zIndex: isDragging ? 2 : undefined }}
      tabIndex={0}
      onKeyDown={onRowKeyDown}
      aria-label={`账号 ${name}，回车编辑`}
      data-account-id={a.id}
    >
      <td className="cell-sort">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="account-sort-handle"
          {...attributes}
          {...listeners}
          disabled={onlyAccount}
          aria-label={`拖动排序 ${name}（当前第 ${index + 1} 位）`}
          title={onlyAccount ? "添加更多账号后可排序" : "拖动调整顺序；空格键开始排序"}
        ><Grip /></button>
      </td>
      <td><input type="checkbox" className="switch" checked={a.enabled} onChange={() => onToggle(a.id)} aria-label={`启用 ${name}`} title={a.enabled ? "点击停用" : "点击启用"} /></td>
      <td className="cell-name">{a.name || <span className="muted">（未命名）</span>}</td>
      <td><span className={`badge ${kind?.group === "官方" ? "badge-official" : "badge-relay"}`}>{kind?.label ?? a.kind}</span></td>
      <td className="cell-url" title={a.baseUrl}>{a.baseUrl}</td>
      <td>{auth ? <span className="badge badge-auth">{auth}</span> : <span className="muted">—</span>}</td>
      <td className="cell-actions">
        <button className="link-btn" onClick={() => onEdit(a)}>编辑</button>
        <button className="link-btn" onClick={() => onDuplicate(a)}>复制</button>
        <button className="link-btn danger" onClick={() => onRemove(a.id)}>删除</button>
      </td>
    </tr>
  );
}

export default function AccountTable({ accounts, onReorder, ...actions }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const startIds = useRef<string[] | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = accounts.map((account) => account.id);
  const activeIndex = ids.indexOf(activeId ?? "");
  const nameOf = (id: string | number) => accounts.find((account) => account.id === id)?.name || "未命名账号";
  const collisionDetection: CollisionDetection = (args) => {
    const pointer = args.pointerCoordinates;
    const bounds = wrapper.current?.getBoundingClientRect();
    if (pointer && bounds && (pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom)) return [];
    return closestCenter(args);
  };
  const clearDrag = () => { setActiveId(null); setOverId(null); startIds.current = null; };
  const finish = ({ active, over }: DragEndEvent) => {
    const unchangedList = startIds.current?.length === ids.length && startIds.current.every((id, index) => id === ids[index]);
    clearDrag();
    // Use the latest account objects so background token rotation or enabled-state changes survive.
    if (!over || !unchangedList) return;
    const next = reorderAccount(accounts, String(active.id), String(over.id));
    if (next !== accounts) onReorder(next);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      modifiers={[restrictToVerticalAxis]}
      onDragStart={({ active }) => { startIds.current = ids; setActiveId(String(active.id)); setOverId(String(active.id)); }}
      onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
      onDragEnd={finish}
      onDragCancel={clearDrag}
      accessibility={{
        screenReaderInstructions: { draggable: "按空格键开始排序，上下方向键移动，再按空格键确认，Esc 取消。" },
        announcements: {
          onDragStart: ({ active }) => `已拿起 ${nameOf(active.id)}，可使用上下方向键调整位置。`,
          onDragOver: ({ active, over }) => over ? `${nameOf(active.id)} 移动到第 ${ids.indexOf(String(over.id)) + 1} 位，共 ${ids.length} 个账号。` : "已移出列表，松开将取消排序。",
          onDragEnd: ({ active, over }) => over ? `已放下 ${nameOf(active.id)}，顺序会自动保存。` : "已取消排序，顺序未改变。",
          onDragCancel: () => "已取消排序，顺序未改变。",
        },
      }}
    >
      <div ref={wrapper} className={`accounts-table-wrap${activeId ? " is-sorting" : ""}`}>
        <table className="accounts-table" aria-label="账号列表，可通过左侧手柄排序">
          <thead><tr>
            <th scope="col" className="cell-sort"><span className="sr-only">排序</span></th>
            {["启用", "名称", "类型", "Base URL", "认证", "操作"].map((label) => <th scope="col" key={label}>{label}</th>)}
          </tr></thead>
          <tbody>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {accounts.map((account, index) => <AccountRow
                key={account.id} account={account} index={index} onlyAccount={accounts.length < 2}
                dropPosition={overId === account.id && activeIndex >= 0 && account.id !== activeId ? (index < activeIndex ? "before" : "after") : undefined}
                {...actions}
              />)}
            </SortableContext>
          </tbody>
        </table>
      </div>
    </DndContext>
  );
}
