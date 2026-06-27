import navigation from "../../../config/navigation.json";

type NavItem = {
  href: string;
  text: string;
};

export type NavigationConfig = {
  nav: NavItem[];
  companiesNav: NavItem[];
  companyNav: NavItem[];
  fundNav: NavItem[];
  indexNav: NavItem[];
};

export const navConfig = navigation as NavigationConfig;
