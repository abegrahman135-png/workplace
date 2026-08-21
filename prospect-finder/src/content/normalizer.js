/** Extract users + pagination cursor from any known IG payload shape. */
export function extractUsers(payload) {
  let users = [];
  let cursor = null;
  let total = 0;

  if (Array.isArray(payload?.users)) {
    users = payload.users;
    cursor = payload.next_max_id || null;
  } else if (payload?.data?.user?.edge_followed_by?.edges) {
    const e = payload.data.user.edge_followed_by;
    users = e.edges.map(x => x.node);
    cursor = e.page_info?.end_cursor || null;
    total = e.count || 0;
  } else if (payload?.data?.user?.edge_follow?.edges) {
    const e = payload.data.user.edge_follow;
    users = e.edges.map(x => x.node);
    cursor = e.page_info?.end_cursor || null;
    total = e.count || 0;
  }

  return { users: users.map(normalize).filter(u => u.username), cursor, total };
}

function normalize(u) {
  return {
    username: u.username || '',
    full_name: u.full_name || '',
    profile_pic_url: u.profile_pic_url || '',
    is_private: Boolean(u.is_private),
    is_verified: Boolean(u.is_verified),
    followed_by_viewer: Boolean(u.followed_by_viewer),
    requested_by_viewer: Boolean(u.requested_by_viewer),
    follows_viewer: Boolean(u.follows_viewer),
  };
}
