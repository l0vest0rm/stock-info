import navigation from "../../../config/navigation.json";

type NavItem = {
  href: string;
  text: string;
  runtime?: "local" | "all";
};

export type NavigationConfig = {
  nav: NavItem[];
  companiesNav: NavItem[];
  companyNav: NavItem[];
  fundNav: NavItem[];
  indexNav: NavItem[];
};

export const navConfig = navigation as NavigationConfig;

/** Local-only pages are intentionally absent from the public Worker UI. */
export function isLocalBrowserRuntime(): boolean {
  return ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname);
}

export function visibleNavigationItems(items: NavItem[]): NavItem[] {
  return items.filter((item) => item.runtime !== "local" || isLocalBrowserRuntime());
}
