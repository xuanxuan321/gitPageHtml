#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
generate_index.py
自动扫描根目录下的小说目录，提取章节信息与正文前10字，生成 books.json
"""

import os
import re
import json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 预设的小说信息（如简介、分类），未配置的将自动生成默认值
BOOK_META = {
    "凡人修仙传": {
        "category": "仙侠",
        "description": "一个普通的山村少年，机缘巧合之下踏入修仙之路。"
    },
    "逆天邪神": {
        "category": "玄幻",
        "description": "掌天毒之珠，承邪神之血，修逆天之力，逆天而行。"
    }
}

def extract_snippet(file_path):
    """
    严格提取文件开头的前10个非空字符
    """
    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            chunk = f.read(500)
            # 过滤空白字符（空格、换行、制表符等）
            chars = [c for c in chunk if not c.isspace()]
            snippet = "".join(chars[:10])
            return snippet if snippet else "暂无预览"
    except Exception as e:
        print(f"读取文件失败: {file_path}, 错误: {e}")
        return "暂无预览"

def scan_books():
    books = []
    
    # 遍历当前目录下的子文件夹
    for item in sorted(os.listdir(BASE_DIR)):
        item_path = os.path.join(BASE_DIR, item)
        if not os.path.isdir(item_path):
            continue
        if item.startswith('.') or item in ['css', 'js', 'assets', '__pycache__']:
            continue
            
        book_name = item
        cover_path = None
        # 查找封面
        for ext in ['封面.jpeg', '封面.jpg', '封面.png', 'cover.jpeg', 'cover.jpg', 'cover.png']:
            possible_cover = os.path.join(item_path, ext)
            if os.path.exists(possible_cover):
                cover_path = f"{book_name}/{ext}"
                break
                
        # 查找章节 txt 文件
        txt_files = []
        for f in os.listdir(item_path):
            if f.endswith('.txt'):
                m = re.match(r'(\d+)-(\d+)', f)
                if m:
                    start_num = int(m.group(1))
                    end_num = int(m.group(2))
                    txt_files.append((start_num, end_num, f))
                else:
                    txt_files.append((999999, 999999, f))
                    
        if not txt_files:
            continue
            
        # 按起始章节数字自然排序
        txt_files.sort(key=lambda x: x[0])
        
        items = []
        for start_num, end_num, fname in txt_files:
            file_abs_path = os.path.join(item_path, fname)
            snippet = extract_snippet(file_abs_path)
            file_size = os.path.getsize(file_abs_path)
            
            if start_num != 999999:
                item_title = f"第{start_num}章 - 第{end_num}章"
                item_id = f"{start_num}-{end_num}"
            else:
                item_title = os.path.splitext(fname)[0]
                item_id = item_title
                
            items.append({
                "id": item_id,
                "title": item_title,
                "snippet": snippet,
                "path": f"{book_name}/{fname}",
                "size": file_size
            })
            
        meta = BOOK_META.get(book_name, {
            "category": "网络小说",
            "description": f"《{book_name}》精彩章节持续收录。"
        })
        
        books.append({
            "id": book_name,
            "title": book_name,
            "cover": cover_path or "",
            "category": meta["category"],
            "description": meta["description"],
            "totalItems": len(items),
            "items": items
        })
        
    return books

def main():
    books = scan_books()
    output_file = os.path.join(BASE_DIR, 'books.json')
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(books, f, ensure_ascii=False, indent=2)
    print(f"成功生成 {output_file}，共包含 {len(books)} 本小说。")
    for b in books:
        print(f" - 《{b['title']}》: 共 {b['totalItems']} 个章节切片，封面: {b['cover']}")

if __name__ == '__main__':
    main()
