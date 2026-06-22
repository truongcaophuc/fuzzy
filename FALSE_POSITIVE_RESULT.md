# Thống kê 50 câu false-positive (có cột Brand bẫy)

Catalog 54 brand · **ngưỡng fuzzy = gating = 75** · phonetic ON · margin 12 · floor 50

> Cột **Brand bẫy** = brand mình CỐ Ý nhắm khi soạn câu (cụm tiếng Việt nghe gần brand đó). So với **Ứng viên fuzzy** + **Câu cuối** để xem hệ có 'sập bẫy' không. `*` = brand không có trong catalog. `—`/(control) = câu sạch, không cố ý bẫy.

## Tổng quan

| | Số |
|---|---|
| Câu CÓ cố ý bẫy | 32/50 |
| Trong đó fuzzy **đề xuất ĐÚNG brand bẫy** (ứng viên trùng) | 19/32 |
| 🔴 AUTO commit | 1/50 · 🟡 LLM giữ 39/50 · 🟢 SKIP 10/50 |
| **Commit PHÁ NGHĨA thật** | **1/50** |

## Chi tiết

| # | Câu (input) | Brand BẪY (cố ý) | Cụm bẫy | Ứng viên fuzzy (top-3) | Gating | Câu CUỐI | Trúng bẫy? |
|---|---|---|---|---|---|---|---|
| 1 | anh đi ra ngoài một lát rồi về | **Adidas** | đi ra | — | 🟢 SKIP | (giữ) | ✅ thoát |
| 2 | tôi qua mặt được nó rồi | **Walmart** | qua mặt | Walmart 83.3 | 🔴 AUTO | tôi Walmart được nó rồi | ⚠️ có |
| 3 | sáng nay ăn phở bò tái nha | **Fox** | phở | Fox 57.1, Adobe 54.5, Sony 54.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 4 | hôm qua nhà có khách | **Honda** | hôm qua | Honda 61.5, Walmart 50.0, KFC 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 5 | con nai vàng ngơ ngác đứng | **Nike** | nai | Visa 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 6 | cô ca sĩ ấy hát rất hay | **Coca-Cola** | cô ca | Coca-Cola 53.3 | 🟡 LLM | (giữ) | ⚠️ có |
| 7 | gút dây giày của con lại | **Goodyear** | gút dây | Colgate 61.5, Coca-Cola 53.3 | 🟡 LLM | (giữ) | ✅ thoát |
| 8 | sắp quay lại trường học rồi | **Subway** | sắp quay | Subway 66.7, Walmart 61.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 9 | anh đi đâu đấy giờ này | **Adidas** | đi đâu | — | 🟢 SKIP | (giữ) | ✅ thoát |
| 10 | hai nơi cách nhau rất xa | **Heineken** | hai nơi | — | 🟢 SKIP | (giữ) | ✅ thoát |
| 11 | mua phở phố cổ hà nội | **Fox** | phở phố | Fox 57.1, Ford 50.0, Coca-Cola 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 12 | u bờ môi bị khô nứt | **Uber** | u bờ | Boeing 54.5, Milo 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 13 | nhà mình sâm sung túc lắm | **Samsung*** | sâm sung | Tesla 54.5, Starbucks 50.0, Sony 50.0 | 🟡 LLM | (giữ) | · |
| 14 | cái nồi in tồ tì rồi | **Intel** | in tồ | Intel 66.7, Domino's 53.3 | 🟡 LLM | (giữ) | ⚠️ có |
| 15 | pha trà mời khách tới chơi | **Puma** | pha | KFC 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 16 | cái phòng này rộng và thoáng | **Fox/Ford** | phòng | Fox 57.1, Ford 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 17 | a đô thị mới đang xây | **Adobe** | a đô | Adobe 54.5, Domino's 50.0, DHL 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 18 | tét nước cho mát mặt | **Tesla** | tét | Mastercard 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 19 | xích cô chó lại kẻo chạy | **Coca-Cola** | cô chó | Coca-Cola 70.6, Chevrolet 55.6, Cisco 54.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 20 | cái seo trên da mặt nó | **Salesforce** | seo | Walmart 66.7, Salesforce 58.8, Tesla 54.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 21 | nai nịt cho gọn gàng vào | **Nike** | nai nịt | Grab 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 22 | bơ gơ lên cao một chút | **Burger King** | bơ gơ | Boeing 60.0, Google 57.1, Goodyear 50.0 | 🟡 LLM | (giữ) | ✅ thoát |
| 23 | đường gồ ghề gờ ráp quá | **Grab** | gờ ráp | Google 72.7, Grab 66.7, Boeing 54.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 24 | đít ni lông phơi ngoài sân | **Disney** | đít ni | Fox 66.7, Ford 57.1, New Balance 55.6 | 🟡 LLM | (giữ) | ✅ thoát |
| 25 | bật xi nhan trước khi rẽ | **—** | (control) | — | 🟢 SKIP | (giữ) | · |
| 26 | con sơn ca hót líu lo | **Sony** | sơn | Sony 66.7, Colgate 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 27 | góc phố quen thuộc ngày xưa | **Fox** | phố | Google 57.1, Fox 50.0, Goodyear 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 28 | nét chữ của em rất đẹp | **Netflix** | nét | — | 🟢 SKIP | (giữ) | ✅ thoát |
| 29 | vô lăng xe hơi bị lệch | **Volkswagen** | vô lăng | Volkswagen 66.7 | 🟡 LLM | (giữ) | ⚠️ có |
| 30 | đi ka ra ô kê tối nay | **—** | (karaoke) | Disney 50.0 | 🟡 LLM | (giữ) | · |
| 31 | ông ba lô đi phượt xa | **Fox** | phượt | Fox 66.7, Ford 50.0 | 🟡 LLM | (giữ) | ⚠️ có |
| 32 | mát xa cho đỡ mỏi vai | **Mastercard** | mát xa | Domino's 61.5 | 🟡 LLM | (giữ) | ✅ thoát |
| 33 | quả dưa hấu này to ghê | **—** | (control) | Walmart 50.0 | 🟡 LLM | (giữ) | · |
| 34 | cái ti vi cũ hỏng rồi | **—** | (control) | Honda 66.7, Visa 50.0 | 🟡 LLM | (giữ) | · |
| 35 | mặt trời lên cao dần | **—** | (control) | Coca-Cola 53.3 | 🟡 LLM | (giữ) | · |
| 36 | lốp xe bị xịt giữa đường | **—** | (control) | Boeing 54.5 | 🟡 LLM | (giữ) | · |
| 37 | cho cốc cà phê sữa đá | **Coca-Cola** | cốc cà | Coca-Cola 62.5, Colgate 57.1, Subway 54.5 | 🟡 LLM | (giữ) | ⚠️ có |
| 38 | nhà ga đông nghẹt người | **—** | (control) | Boeing 60.0, Sony 50.0, Netflix 50.0 | 🟡 LLM | (giữ) | · |
| 39 | con cò bay lả bay la | **Coca-Cola** | con cò | Coca-Cola 62.5, Colgate 57.1 | 🟡 LLM | (giữ) | ⚠️ có |
| 40 | đi bộ ra biển hóng gió | **—** | (control) | Honda 66.7, Boeing 60.0 | 🟡 LLM | (giữ) | · |
| 41 | tô bún bò huế cay | **—** | (control) | Boeing 54.5 | 🟡 LLM | (giữ) | · |
| 42 | mật ong rừng nguyên chất | **—** | (control) | — | 🟢 SKIP | (giữ) | · |
| 43 | mua tô mì gói ăn liền | **Milo** | mì gói | Milo 66.7, Apple 54.5, Domino's 53.3 | 🟡 LLM | (giữ) | ⚠️ có |
| 44 | ai phôn của tôi hết pin | **iPhone*** | ai phôn | Fox 66.7, Ford 57.1, Heineken 57.1 | 🟡 LLM | (giữ) | · |
| 45 | ba con mèo nằm ngủ | **—** | (control) | Boeing 54.5, McDonald's 50.0 | 🟡 LLM | (giữ) | · |
| 46 | chia đôi cái bánh ra | **—** | (control) | — | 🟢 SKIP | (giữ) | · |
| 47 | gặp lại bạn cũ vui ghê | **—** | (control) | — | 🟢 SKIP | (giữ) | · |
| 48 | sa mạc nắng cháy da | **—** | (control) | — | 🟢 SKIP | (giữ) | · |
| 49 | nồi cơm điện nhà mình | **—** | (control) | Disney 60.0, Domino's 53.3, Nike 50.0 | 🟡 LLM | (giữ) | · |
| 50 | đi chợ mua mớ rau | **—** | (control) | — | 🟢 SKIP | (giữ) | · |

## Ghi chú
- **Trúng bẫy ⚠️** = ứng viên fuzzy CÓ đúng brand bẫy (nó 'nghe ra' brand đó). Nhưng phần lớn chỉ là ỨNG VIÊN (🟡 LLM giữ), KHÔNG commit → không phá câu.
- **Thoát ✅** = brand bẫy KHÔNG lọt vào ứng viên (guard/âm-đầu/độ-dài chặn được).
- **Commit phá nghĩa** = chỉ ca 🔴 AUTO mà đổi nghĩa thật (qua mặt→Walmart).
