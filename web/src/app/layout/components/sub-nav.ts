import { defineComponent, h } from "vue";
import { navConfig, visibleNavigationItems } from "../config/navigation";

type NavItem = {
  href: string;
  text: string;
};

function subnavItems(kind: string): NavItem[] {
  switch (kind) {
    case "companies":
      return visibleNavigationItems(navConfig.companiesNav);
    case "company":
      return visibleNavigationItems(navConfig.companyNav);
    case "fund":
      return visibleNavigationItems(navConfig.fundNav);
    case "index":
      return visibleNavigationItems(navConfig.indexNav);
    default:
      return [];
  }
}

function subnavClass(page: string, href: string): string {
  const stateClass = page === href ? "btn-success active" : "btn-outline-success";
  return `btn btn-sm ${stateClass}`;
}

function withCurrentSecurityCode(href: string): string {
  const code = new URLSearchParams(window.location.search).get("code");
  if (!code) return href;
  const target = new URL(href, window.location.href);
  target.searchParams.set("code", code);
  return `${target.pathname.split("/").pop() || href}${target.search}`;
}

function renderSubnavLinks(kind: string, page: string) {
  return subnavItems(kind).map((item) =>
    h(
      "a",
      {
        key: item.href,
        href: kind === "company" ? withCurrentSecurityCode(item.href) : item.href,
        name: "codeSpec",
        class: subnavClass(page, item.href),
        "aria-current": page === item.href ? "true" : undefined,
      },
      item.text
    )
  );
}

export const SubNav = defineComponent({
  name: "SubNav",
  props: {
    kind: {
      type: String,
      required: true,
    },
    page: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    return () => {
      const nested = props.kind === "fund" || props.kind === "index";
      const buttonGroup = h(
        "div",
        { class: "d-flex flex-wrap justify-content-center gap-2 company-subnav-pills", role: "group" },
        renderSubnavLinks(props.kind, props.page)
      );
      if (nested) {
        return h("div", { id: "container", class: "py-2" }, [h("div", { class: "text-center" }, [buttonGroup])]);
      }
      return h("div", { class: "container text-center my-2" }, [buttonGroup]);
    };
  },
});
