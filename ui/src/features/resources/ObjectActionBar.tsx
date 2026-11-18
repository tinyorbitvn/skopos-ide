import { IconButton, Menu } from "../../design";
import { Ellipsis } from "../../design/icons";
import styles from "./ObjectActionBar.module.css";
import { DELETE_ACTION_ID, type ObjectActionItem } from "./objectActions";
import { menuItems } from "./ResourceActions";

function ActionButton(props: { item: ObjectActionItem }) {
  const { item } = props;
  const Icon = item.icon;
  return (
    <IconButton
      label={item.label}
      icon={<Icon size={16} aria-hidden="true" />}
      disabled={item.disabled}
      onClick={item.run}
      data-testid={`detail-action-${item.id}`}
    />
  );
}

/**
 * The drawer header's actions: an icon button for each top item, then Delete, then More
 * actions with the rest of the list: the one the row menu shows, without Delete.
 */
export function ObjectActionBar(props: { items: ObjectActionItem[] }) {
  const remove = props.items.find((it) => it.id === DELETE_ACTION_ID);
  const items = props.items.filter((it) => it !== remove);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and a legend that a header toolbar does not want.
    <div
      role="group"
      aria-label="Actions"
      className={styles.bar}
      data-testid="detail-actions"
    >
      {items
        .filter((it) => it.top)
        .map((it) => (
          <ActionButton key={it.id} item={it} />
        ))}
      {remove ? <ActionButton item={remove} /> : null}
      {items.some((it) => !it.top) ? (
        <Menu
          trigger={
            <IconButton
              label="More actions"
              tooltip={false}
              icon={<Ellipsis size={16} aria-hidden="true" />}
              data-testid="detail-more-actions"
            />
          }
          items={menuItems(items)}
        />
      ) : null}
    </div>
  );
}
