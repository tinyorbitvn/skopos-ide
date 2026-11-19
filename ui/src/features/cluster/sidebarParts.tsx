import { NavLink, type NavLinkProps } from "react-router";
import { useNavItem } from "../../app/tabs/navigation";
import { ProjectLogo } from "../../design/ProjectLogo";
import type { NavIcon } from "../../kinds/nav";

/**
 * A navigation item: a click, Ctrl/Cmd+click, middle-click or double-click opens its
 * location in a tab (spec P11 to P13), and it is active on the focused tab's location.
 */
export function NavItemLink(props: Omit<NavLinkProps, "to"> & { to: string }) {
  const handlers = useNavItem(props.to);
  return <NavLink {...props} {...handlers} />;
}

/** A section's icon, or its project's logo for Helm and Argo. Hidden from assistive technology. */
export function SectionIcon(props: {
  icon: NavIcon;
  size: number;
  className?: string;
}) {
  const { icon, size, className } = props;
  if (typeof icon === "string") {
    return <ProjectLogo name={icon} size={size} className={className} />;
  }
  const Glyph = icon;
  return <Glyph size={size} className={className} />;
}
