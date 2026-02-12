// static/avatar.js
export async function loadAvatar(mountSelector = "#avatarMount", svgUrl = "./avatar-simple.svg") {
  const mount = typeof mountSelector === "string" ? document.querySelector(mountSelector) : mountSelector;
  if (!mount) throw new Error(`loadAvatar: mount not found: ${mountSelector}`);

  const res = await fetch(svgUrl, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load avatar: ${svgUrl} (${res.status})`);
  const svgText = await res.text();

  mount.innerHTML = svgText;

  // important: keep these IDs in your SVG
  const mouth = mount.querySelector("#mouth");
  const lids = { left: mount.querySelector("#lidL"), right: mount.querySelector("#lidR") };
  return { mount, mouth, lids };
}
