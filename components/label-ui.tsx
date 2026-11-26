import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { Tag } from "lucide-react";
import { useMemo } from "react";
import { useTranslations } from "use-intl";
import type { PickerTrigger } from "@/components/compact-trigger";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import type { LabelLite } from "@/lib/db/schema";

// A colored label pill. Color is a hex string; we tint the background and
// border from it (Tailwind can't express dynamic colors, so inline style).
export function LabelChip({ label }: { label: LabelLite }) {
  return (
    <span
      className="inline-flex max-w-28 shrink-0 items-center overflow-hidden rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap"
      title={label.name}
      style={{
        color: label.color,
        borderColor: `${label.color}66`,
        backgroundColor: `${label.color}1a`,
      }}
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
}

// `max` caps how many chips render; the rest collapse into a `+N` chip that
// lists them on hover. Dense rows (table cells) pass a small max so a heavily
// labelled issue can't wrap the row into three lines.
export function LabelChips({
  labels,
  className,
  max,
}: {
  labels: LabelLite[];
  className?: string;
  max?: number;
}) {
  if (labels.length === 0) return null;
  const shown = max === undefined ? labels : labels.slice(0, max);
  const rest = labels.slice(shown.length);
  return (
    <span className={className ?? "inline-flex flex-wrap items-center gap-1"}>
      {shown.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      {rest.length > 0 ? (
        <span
          className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
          title={rest.map((l) => l.name).join(", ")}
        >
          +{rest.length}
        </span>
      ) : null}
    </span>
  );
}

// Searchable multi-select label picker. Picking or unpicking a row calls
// `onChange` with the new id set; the caller persists it.
export function LabelPicker({
  allLabels,
  selected,
  onChange,
  trigger,
}: {
  allLabels: LabelLite[];
  selected: string[];
  onChange: (labelIds: string[]) => void;
  /** A caller-drawn trigger (issue property chips); replaces the button. */
  trigger?: PickerTrigger;
}) {
  const t = useTranslations("issueDetail");
  const tCommon = useTranslations("common");
  const byId = useMemo(
    () => new Map(allLabels.map((l) => [l.id, l])),
    [allLabels]
  );
  const items = useMemo(() => allLabels.map((l) => l.id), [allLabels]);

  return (
    <Combobox
      multiple
      autoHighlight
      items={items}
      value={selected}
      onValueChange={(next: string[]) => onChange(next)}
      itemToStringLabel={(id: string) => byId.get(id)?.name ?? ""}
    >
      {trigger ? (
        <ComboboxPrimitive.Trigger render={trigger.render}>
          {trigger.content}
        </ComboboxPrimitive.Trigger>
      ) : (
        <ComboboxPrimitive.Trigger
          render={
            <Button variant="outline" size="sm" className="h-8 justify-start" />
          }
        >
          <Tag className="size-3.5" />
          {t("labels")}
        </ComboboxPrimitive.Trigger>
      )}
      <ComboboxContent className="w-64">
        <ComboboxInput showTrigger={false} placeholder={tCommon("search")} />
        <ComboboxEmpty>{tCommon("noResults")}</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            const l = byId.get(id);
            if (!l) return null;
            return (
              <ComboboxItem key={l.id} value={l.id}>
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                <span className="truncate">{l.name}</span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
