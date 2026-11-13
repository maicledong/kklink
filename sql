-- 如果一开始没建表，执行这个：
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    title TEXT,
    description TEXT,
    image_url TEXT,
    img_file_id TEXT,
    vid_file_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
