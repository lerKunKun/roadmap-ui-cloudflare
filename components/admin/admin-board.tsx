"use client"

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"
import { CalendarClock, GripVertical, Pencil, ThumbsUp, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  STATUS_COLUMNS,
  type RoadmapItem,
  type RoadmapStatus,
} from "@/features/roadmap/types"

interface AdminBoardProps {
  items: RoadmapItem[]
  movingItemId: string | null
  onEdit(item: RoadmapItem): void
  onDelete(item: RoadmapItem): void
  onMove(itemId: string, status: RoadmapStatus, sortOrder: number): Promise<void>
}

export function AdminBoard({
  items,
  movingItemId,
  onEdit,
  onDelete,
  onMove,
}: AdminBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  )

  function dragEnd(event: DragEndEvent) {
    const itemId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : ""
    const overItem = overId.startsWith("item:")
      ? items.find((item) => item.id === overId.slice(5))
      : null
    const status = overItem?.status ?? overId.slice(7)
    if (!STATUS_COLUMNS.some((column) => column.value === status)) return
    const destination = items
      .filter((item) => item.status === status && item.id !== itemId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
    const targetIndex = overItem
      ? Math.max(0, destination.findIndex((item) => item.id === overItem.id))
      : destination.length
    void onMove(itemId, status as RoadmapStatus, targetIndex)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
      <div className="roadmap-board grid grid-flow-col gap-3 overflow-x-auto pb-3" aria-label="管理 Roadmap 看板">
        {STATUS_COLUMNS.map((column) => {
          const columnItems = items
            .filter((item) => item.status === column.value)
            .sort((a, b) => a.sortOrder - b.sortOrder)
          return (
            <AdminColumn
              key={column.value}
              status={column.value}
              label={column.label}
              items={columnItems}
              movingItemId={movingItemId}
              onEdit={onEdit}
              onDelete={onDelete}
              onMove={onMove}
            />
          )
        })}
      </div>
    </DndContext>
  )
}

function AdminColumn({
  status,
  label,
  items,
  movingItemId,
  onEdit,
  onDelete,
  onMove,
}: {
  status: RoadmapStatus
  label: string
  items: RoadmapItem[]
  movingItemId: string | null
  onEdit(item: RoadmapItem): void
  onDelete(item: RoadmapItem): void
  onMove(itemId: string, status: RoadmapStatus, sortOrder: number): Promise<void>
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` })

  return (
    <section
      ref={setNodeRef}
      aria-label={label}
      className={`min-h-[34rem] rounded-xl border bg-card p-3 transition-colors ${isOver ? "border-primary bg-blue-50/50 dark:bg-blue-950/20" : ""}`}
    >
      <div className="mb-3 flex items-center gap-2 border-b pb-3">
        <span className="size-2 rounded-full bg-primary/70" />
        <h2 className="text-sm font-semibold">{label}</h2>
        <Badge variant="secondary" className="ml-auto tabular-nums">{items.length}</Badge>
      </div>
      <div className="grid gap-2.5">
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-10 text-center text-xs text-muted-foreground">拖放条目到这里</p>
        ) : null}
        {items.map((item) => (
          <AdminCard
            key={item.id}
            item={item}
            moving={movingItemId === item.id}
            onEdit={onEdit}
            onDelete={onDelete}
            onMove={onMove}
          />
        ))}
      </div>
    </section>
  )
}

function AdminCard({
  item,
  moving,
  onEdit,
  onDelete,
  onMove,
}: {
  item: RoadmapItem
  moving: boolean
  onEdit(item: RoadmapItem): void
  onDelete(item: RoadmapItem): void
  onMove(itemId: string, status: RoadmapStatus, sortOrder: number): Promise<void>
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    transform,
    isDragging,
  } = useDraggable({ id: item.id })
  const {
    setNodeRef: setDroppableRef,
    isOver,
  } = useDroppable({ id: `item:${item.id}` })

  function setCardRef(node: HTMLElement | null) {
    setDraggableRef(node)
    setDroppableRef(node)
  }

  return (
    <article
      ref={setCardRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={`rounded-xl border bg-background p-3 shadow-xs ${isDragging ? "z-10 opacity-70 shadow-lg" : ""} ${isOver && !isDragging ? "border-primary" : ""}`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="mt-0.5 cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`拖动“${item.title}”`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-5">{item.title}</h3>
          {item.description ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p> : null}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3 pl-7 text-[0.7rem] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><ThumbsUp className="size-3" />{item.voteCount}</span>
        <span className="inline-flex items-center gap-1"><CalendarClock className="size-3" />{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(item.createdAt))}</span>
      </div>
      <div className="mt-3 flex items-center gap-1.5 border-t pt-2.5">
        <select
          aria-label={`调整“${item.title}”阶段`}
          value={item.status}
          disabled={moving}
          onChange={(event) => void onMove(item.id, event.target.value as RoadmapStatus, 0)}
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {STATUS_COLUMNS.map((column) => <option key={column.value} value={column.value}>{column.label}</option>)}
        </select>
        <Button size="icon-xs" variant="ghost" onClick={() => onEdit(item)} aria-label={`编辑“${item.title}”`}><Pencil /></Button>
        <Button size="icon-xs" variant="ghost" onClick={() => onDelete(item)} aria-label={`删除“${item.title}”`}><Trash2 /></Button>
      </div>
    </article>
  )
}
