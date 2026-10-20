'use strict';
/**
 * demo_data.js — Seeds realistic real Indian data into the Global Spatial Vault.
 * Covers states, districts, sub_districts, villages, village_amenities, lgd_panchayats,
 * cities, businesses, reviews, leads, claims, crowdsourced hazards, and amenity contributions.
 */
const { open } = require('../lib/db');
const db = open();

console.log('Seeding demo & crowdsourced tables in Spatial Vault...');

// 1. States
const insertState = db.prepare(`
  INSERT OR IGNORE INTO states (code, name, name_hi, slug)
  VALUES (?, ?, ?, ?)
`);
const states = [
  ['PB', 'Punjab', 'पंजाब', 'punjab'],
  ['DL', 'Delhi', 'दिल्ली', 'delhi'],
  ['MH', 'Maharashtra', 'महाराष्ट्र', 'maharashtra'],
  ['KA', 'Karnataka', 'कर्नाटक', 'karnataka'],
  ['UP', 'Uttar Pradesh', 'उत्तर प्रदेश', 'uttar-pradesh'],
  ['TN', 'Tamil Nadu', 'तमिलनाडु', 'tamil-nadu'],
  ['HR', 'Haryana', 'हरियाणा', 'haryana'],
  ['RJ', 'Rajasthan', 'राजस्थान', 'rajasthan'],
];
for (const s of states) insertState.run(...s);

// 2. Districts
const insertDistrict = db.prepare(`
  INSERT OR IGNORE INTO districts (state_id, code, name, slug)
  VALUES ((SELECT id FROM states WHERE code = ?), ?, ?, ?)
`);
const districts = [
  ['PB', 'PB-ASR', 'Amritsar', 'amritsar'],
  ['PB', 'PB-LDH', 'Ludhiana', 'ludhiana'],
  ['DL', 'DL-CD', 'Central Delhi', 'central-delhi'],
  ['DL', 'DL-SD', 'South Delhi', 'south-delhi'],
  ['MH', 'MH-MUM', 'Mumbai Suburban', 'mumbai-suburban'],
  ['MH', 'MH-PUN', 'Pune', 'pune'],
  ['KA', 'KA-BLR', 'Bengaluru Urban', 'bengaluru-urban'],
  ['UP', 'UP-GBN', 'Gautam Buddha Nagar', 'gautam-buddha-nagar'],
  ['HR', 'HR-GUR', 'Gurugram', 'gurugram'],
  ['RJ', 'RJ-JAI', 'Jaipur', 'jaipur'],
];
for (const d of districts) insertDistrict.run(...d);

// 3. Sub Districts
const insertSubDistrict = db.prepare(`
  INSERT OR IGNORE INTO sub_districts (district_id, code, name, slug)
  VALUES ((SELECT id FROM districts WHERE slug = ?), ?, ?, ?)
`);
const subDistricts = [
  ['amritsar', 'SUB-ASR1', 'Amritsar-I', 'amritsar-1'],
  ['ludhiana', 'SUB-LDHW', 'Ludhiana West', 'ludhiana-west'],
  ['central-delhi', 'SUB-CP', 'Connaught Place', 'connaught-place'],
  ['south-delhi', 'SUB-HK', 'Hauz Khas', 'hauz-khas'],
  ['mumbai-suburban', 'SUB-AND', 'Andheri', 'andheri'],
  ['pune', 'SUB-HAV', 'Haveli', 'haveli'],
  ['bengaluru-urban', 'SUB-BLRS', 'Bangalore South', 'bangalore-south'],
  ['gautam-buddha-nagar', 'SUB-DAD', 'Dadri', 'dadri'],
];
for (const sd of subDistricts) insertSubDistrict.run(...sd);

// 4. Villages
const insertVillage = db.prepare(`
  INSERT OR REPLACE INTO villages (sub_district_id, name, slug, pincode, census_code, lgd_code, population, households, lat, lon, digipin, ai_description)
  VALUES ((SELECT id FROM sub_districts WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const villages = [
  ['amritsar-1', 'Attari', 'attari', '143108', '037812', 'LGD-0378', 8420, 1540, 31.6035, 74.6048, '489FP23K8M', 'Historic border village known for the Attari-Wagah ceremonial border and trade terminal.'],
  ['ludhiana-west', 'Kila Raipur', 'kila-raipur', '141201', '038945', 'LGD-0389', 5890, 1120, 30.7612, 75.8234, '489FP88T1K', 'Famous for the annual Rural Olympics showcasing traditional sports, cart races, and athletics.'],
  ['hauz-khas', 'Chhatarpur', 'chhatarpur', '110074', '063821', 'LGD-0638', 21450, 4820, 28.5023, 77.1782, '492FJT6M7C', 'Heritage locality housing ancient temples, green belts, and agricultural farmhouses.'],
  ['andheri', 'Marol Village', 'marol-village', '400059', '092831', 'LGD-0928', 34200, 7890, 19.1176, 72.8791, '387KT44M9P', 'Urban gaothan locality surrounded by modern hospitality, IT parks, and metro lines.'],
  ['bangalore-south', 'Gottigere', 'gottigere', '560083', '112940', 'LGD-1129', 18900, 4210, 12.8598, 77.5899, '284HP92L4R', 'Growing suburban village hub along Bannerghatta Road near the National Park sanctuary.'],
  ['dadri', 'Surajpur', 'surajpur', '201306', '084721', 'LGD-0847', 14200, 3110, 28.5132, 77.4921, '492FKM8P3X', 'Scenic wetland bird sanctuary perimeter with bustling rural commercial marketplace.'],
];
for (const v of villages) insertVillage.run(...v);

// 5. Village Amenities
const insertAmenity = db.prepare(`
  INSERT OR REPLACE INTO village_amenities (census_code, road, drinking_water, electricity, school, hospital, bus_stop, railway_station, mobile_network, bank_atm, famous_for, source, verified_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const amenities = [
  ['037812', 'Paved National Highway Link', 'Treated Tap Water', '24x7 3-phase', 'Govt Senior Secondary School', 'Civil Hospital Attari (2 km)', 'Yes, Attari GT Road', 'Attari Sham Singh Station (1.2 km)', 'Jio 5G, Airtel 5G, BSNL', 'SBI ATM & PNB Branch', 'Attari-Wagah Joint Check Post & Historic Heritage', 'census2011', '2026-10-18'],
  ['038945', 'Metalled District Road', 'Piped Water Supply', '24x7 Grid', 'Khalsa High School', 'PHC Kila Raipur (within village)', 'Yes, Main Chowk', 'Kila Raipur Halt (0.8 km)', 'Airtel, Jio, Vi', 'HDFC & Cooperative Bank', 'Rural Olympics (Kila Raipur Sports Festival)', 'census2011', '2026-10-15'],
  ['063821', 'Paved Bituminous Road', 'Delhi Jal Board Supply', 'BSES Rajdhani 24x7', 'Kendriya Vidyalaya & St. Marks', 'Fortis Vasant Kunj (4 km)', 'Chhatarpur Mandir Bus Stop', 'Chhatarpur Metro (0.5 km)', 'All 5G Networks', 'ICICI, Axis, SBI ATMs', 'Historical Chhatarpur Temple Complex', 'census2011', '2026-10-19'],
  ['092831', 'Concrete Municipal Road', 'BMC 24x7 supply', 'Adani Electricity 24x7', 'St. John High School', 'SevenHills Hospital (1.5 km)', 'Marol Naka Bus Depot', 'Marol Naka Metro Line 1 & Line 3', 'Jio, Airtel 5G', 'Multiple ATMs within 200m', 'Commercial & Hospitality Hub near Airport', 'census2011', '2026-10-14'],
  ['112940', 'Asphalt 4-Lane Access Road', 'BWSSB Cauvery Supply', 'BESCOM 24x7', 'Loyola High School', 'Apollo Clinic Bannerghatta (3 km)', 'Gottigere BMTC Depot', 'Silk Institute Metro (4.5 km)', 'All Networks High Speed 5G', 'Canara & SBI ATMs', 'Bannerghatta Nature Reserve Gateway', 'census2011', '2026-10-17'],
  ['084721', 'Paved Industrial Bypass', 'Piped Deep Borewell', 'NPCL 24x7', 'Govt Inter College', 'Sharda Hospital (5 km)', 'Surajpur Chowk Stand', 'Noida Sec 142 Metro (6 km)', 'Jio 5G, Airtel 5G', 'PNB, IndusInd ATMs', 'Surajpur Wetland & Bird Sanctuary', 'census2011', '2026-10-12'],
];
for (const a of amenities) insertAmenity.run(...a);

// 6. Cities
const insertCity = db.prepare(`
  INSERT OR IGNORE INTO cities (name, slug, state, district, pincode, lat, lng)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const cities = [
  ['Amritsar', 'amritsar', 'Punjab', 'Amritsar', '143001', 31.6340, 74.8723],
  ['Ludhiana', 'ludhiana', 'Punjab', 'Ludhiana', '141001', 30.9010, 75.8573],
  ['New Delhi', 'new-delhi', 'Delhi', 'Central Delhi', '110001', 28.6139, 77.2090],
  ['Noida', 'noida', 'Uttar Pradesh', 'Gautam Buddha Nagar', '201301', 28.5355, 77.3910],
  ['Gurgaon', 'gurgaon', 'Haryana', 'Gurugram', '122001', 28.4595, 77.0266],
  ['Mumbai', 'mumbai', 'Maharashtra', 'Mumbai Suburban', '400001', 18.9388, 72.8354],
  ['Bengaluru', 'bengaluru', 'Karnataka', 'Bengaluru Urban', '560001', 12.9716, 77.5946],
  ['Pune', 'pune', 'Maharashtra', 'Pune', '411001', 18.5204, 73.8567],
  ['Jaipur', 'jaipur', 'Rajasthan', 'Jaipur', '302001', 26.9124, 75.7873],
];
for (const c of cities) insertCity.run(...c);

// 7. Businesses
const insertBusiness = db.prepare(`
  INSERT OR REPLACE INTO businesses (name, slug, category, niche, city, address, area, pincode, lat, lng, phone, whatsapp, website, email, description, price_range, opening_time, closing_time, is_featured, is_verified, status, plan, avg_rating, review_count, view_count, call_count, submitted_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const businesses = [
  ['Kesar Da Dhaba', 'kesar-da-dhaba', 'Restaurants', 'dhabanearme', 'Amritsar', 'Chowk Passian, Near Town Hall', 'Heritage City', '143001', 31.6253, 74.8765, '+91 183 2552103', '+91 98141 23456', 'https://kesardadhaba.in', 'contact@kesardadhaba.in', 'Legendary Punjabi vegetarian dhaba established in 1916, world-renowned for slow-cooked Maa Ki Dal and Parathas.', '$$', '11:30', '23:00', 1, 1, 'published', 'premium', 4.8, 1240, 8540, 620, 'admin'],
  ['Wenger\'s Deli & Bakery', 'wengers-deli-bakery', 'Bakery', 'bakerynearme', 'New Delhi', 'A16, Radial Road 3, Connaught Place', 'Connaught Place', '110001', 28.6328, 77.2195, '+91 11 23324403', '+91 98102 33403', 'https://wengers.co.in', 'orders@wengers.co.in', 'Delhi\'s oldest confectionery and Swiss bakery serving artisan patties, eclairs, and baguettes since 1926.', '$$', '10:30', '20:00', 1, 1, 'published', 'featured', 4.7, 980, 7120, 480, 'admin'],
  ['Indian Coffee House', 'indian-coffee-house-cp', 'Cafes', 'cafenearme', 'New Delhi', '2nd Floor, Mohan Singh Place, Baba Kharak Singh Marg', 'Connaught Place', '110001', 28.6312, 77.2168, '+91 11 23342994', '', '', '', 'Historic cooperative cafe gathering intellectuals, journalists, and students for South Indian filter coffee and mutton dosas.', '$', '09:00', '21:00', 0, 1, 'published', 'free', 4.4, 650, 4390, 210, 'admin'],
  ['Blue Tokai Coffee Roasters', 'blue-tokai-gurgaon', 'Cafes', 'cafenearme', 'Gurgaon', 'SCO 34, Sector 29 Market', 'Sector 29', '122002', 28.4682, 77.0631, '+91 98214 55012', '+91 98214 55012', 'https://bluetokaicoffee.com', 'hi@bluetokaicoffee.com', 'Specialty craft coffee roastery offering single-origin Indian estate pour-overs, cold brews, and sourdough bakes.', '$$$', '08:00', '22:30', 1, 1, 'published', 'premium', 4.6, 420, 3180, 240, 'admin'],
  ['Bosch Car Service Ludhiana', 'bosch-car-service-ludhiana', 'Auto Services', 'carrepairsnearme', 'Ludhiana', 'Plot 45, Ferozepur Road, Opposite PAU Gate 2', 'PAU Zone', '141012', 30.8921, 75.8114, '+91 161 5012890', '+91 98765 43210', 'https://boschcarservice.in', 'service.ldh@bosch.in', 'Authorised multi-brand diagnostic center with computerised wheel alignment, AC servicing, and authentic parts.', '$$', '08:30', '19:30', 1, 1, 'published', 'featured', 4.6, 215, 1890, 310, 'admin'],
  ['Apollo White Dental Clinic', 'apollo-white-dental-blr', 'Dental Clinic', 'dentistsnearme', 'Bengaluru', '482, CMH Road, Stage 2, Indiranagar', 'Indiranagar', '560038', 12.9719, 77.6412, '+91 80 41151234', '+91 99000 88776', 'https://apollowhitedental.com', 'indiranagar@apollowhitedental.com', 'State-of-the-art dental hospital providing laser teeth whitening, invisible aligners, dental implants, and pediatric care.', '$$$', '09:00', '21:00', 1, 1, 'published', 'premium', 4.9, 310, 2980, 410, 'admin'],
  ['Raymond Custom Tailoring Studio', 'raymond-tailoring-delhi', 'Tailoring', 'tailorshopnearme', 'New Delhi', 'E-14, South Extension Part 1', 'South Extension', '110049', 28.5714, 77.2210, '+91 11 41648820', '+91 98111 22334', 'https://raymond.in', 'southex@raymond.in', 'Bespoke master craftsmanship for tuxedos, sherwanis, formal suits, and custom-measured corporate attire.', '$$$', '10:30', '20:30', 1, 1, 'published', 'featured', 4.7, 180, 2140, 195, 'admin'],
  ['Mavalli Tiffin Room (MTR)', 'mavalli-tiffin-room-mtr', 'Restaurants', 'restaurants', 'Bengaluru', '14, Lalbagh Road, Mavalli', 'Lalbagh', '560004', 12.9556, 77.5855, '+91 80 22220022', '', 'https://mtr1924.com', 'feedback@mtr1924.com', 'Heritage vegetarian institution famed since 1924 for inventing the Rava Idli, silver cup filter coffee, and Chandrahara.', '$$', '06:30', '21:30', 1, 1, 'published', 'premium', 4.8, 2400, 14200, 980, 'admin'],
  ['Kayani Bakery', 'kayani-bakery-pune', 'Bakery', 'bakerynearme', 'Pune', '6, Dr. Coyaji Road, East Street, Camp', 'Camp', '411001', 18.5144, 73.8792, '+91 20 26360517', '', '', '', 'Legendary Parsi bakery famed across India for melt-in-the-mouth Shrewsbury biscuits and Madeira cakes.', '$$', '07:30', '19:00', 1, 1, 'published', 'featured', 4.7, 1850, 9300, 720, 'admin'],
  ['Green Pharmacy & Wellness', 'green-pharmacy-mumbai', 'Pharmacy', 'medicalshopnearme', 'Mumbai', 'Shop 3, Hill Road, Bandra West', 'Bandra', '400050', 19.0596, 72.8295, '+91 22 26421980', '+91 98200 44556', 'https://greenpharmacy.in', 'bandra@greenpharmacy.in', '24x7 community pharmacy with home delivery, authentic ayurvedic formulations, and temperature-controlled storage.', '$$', '00:00', '23:59', 0, 1, 'published', 'free', 4.5, 94, 1430, 280, 'admin'],
  ['Nature\'s Basket Daily Grocery', 'natures-basket-koramangala', 'Grocery', 'grocerystoresnearme', 'Bengaluru', '80 Feet Road, 4th Block, Koramangala', 'Koramangala', '560034', 12.9352, 77.6245, '+91 80 41258800', '+91 97400 12345', 'https://naturesbasket.co.in', 'help@naturesbasket.co.in', 'Gourmet supermarket offering organic produce, imported cheeses, gluten-free pantry essentials, and fresh baked goods.', '$$$', '08:00', '22:00', 1, 1, 'published', 'featured', 4.6, 320, 2760, 190, 'admin'],
];
for (const b of businesses) insertBusiness.run(...b);

// 8. Reviews
const insertReview = db.prepare(`
  INSERT OR REPLACE INTO reviews (business_id, business_name, user_name, user_email, rating, title, body, is_verified, helpful_count)
  VALUES ((SELECT id FROM businesses WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?)
`);
const reviews = [
  ['kesar-da-dhaba', 'Kesar Da Dhaba', 'Harpreet Singh Sandhu', 'harpreet.sandhu@gmail.com', 5, 'Unmatched Dal Makhani in the heart of Amritsar', 'Visited with family during our Golden Temple trip. The slow-simmered dal cooked in ghee for 24 hours has no equal. Absolutely authentic atmosphere!', 1, 38],
  ['wengers-deli-bakery', 'Wenger\'s Deli & Bakery', 'Ananya Sharma', 'ananya.s@outlook.com', 5, 'Best shammi kebabs and chocolate mousse in Delhi', 'My grandfather used to buy bread here, and 50 years later the quality has not dropped one bit. The mutton puff is flaky perfection.', 1, 24],
  ['blue-tokai-gurgaon', 'Blue Tokai Coffee Roasters', 'Rohit Malhotra', 'rohit.m@zomato.in', 5, 'Perfect remote work spot with artisanal coffee', 'Excellent flat white made with Attikan Estate beans. The seating is comfortable, WiFi is ultra fast, and staff knows their coffee notes.', 1, 19],
  ['bosch-car-service-ludhiana', 'Bosch Car Service Ludhiana', 'Jaswinder Grewal', 'jassi.grewal@yahoo.com', 5, 'Transparent diagnosis, no unnecessary parts billed', 'Had an electrical issue in my Hyundai Creta that two local garages failed to fix. Bosch engineers diagnosed a faulty sensor in 20 minutes.', 1, 15],
  ['apollo-white-dental-blr', 'Apollo White Dental Clinic', 'Dr. Meera Nambiar', 'meera.nambiar@aiims.edu', 5, 'Painless root canal treatment', 'Top tier hygiene and modern imaging machines. Dr. Priya explained every step on the monitor before beginning.', 1, 12],
  ['kayani-bakery-pune', 'Kayani Bakery', 'Firoze Batliwala', 'firoze.b@gmail.com', 5, 'The real Shrewsbury biscuits of Pune', 'Queue starts at 7 AM for a reason! Nothing beats their freshly packed warm biscuits with afternoon tea.', 1, 45],
];
for (const r of reviews) insertReview.run(...r);

// 9. Leads (Inquiries)
const insertLead = db.prepare(`
  INSERT OR REPLACE INTO leads (business_id, business_name, customer_name, phone, email, message, plan, status, source_page)
  VALUES ((SELECT id FROM businesses WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?)
`);
const leads = [
  ['kesar-da-dhaba', 'Kesar Da Dhaba', 'Simranjit Kaur', '+91 98888 12345', 'simran.k@yahoo.co.in', 'Inquiring about bulk catering delivery for 60 guests wedding lunch in Amritsar this Sunday.', 'premium', 'contacted', '/niche/dhabanearme/kesar-da-dhaba'],
  ['wengers-deli-bakery', 'Wenger\'s Deli & Bakery', 'Vivek Singhania', '+91 98110 54321', 'v.singhania@corp.in', 'Need custom tiered anniversary cake and 100 savory snack boxes for corporate office celebration.', 'featured', 'new', '/niche/bakerynearme/wengers-deli-bakery'],
  ['bosch-car-service-ludhiana', 'Bosch Car Service Ludhiana', 'Baldev Dhillon', '+91 98720 99887', 'dhillon.farms@gmail.com', 'Requesting quote for full 60,000 km periodic service & brake overhaul for Toyota Fortuner.', 'featured', 'converted', '/niche/carrepairsnearme/bosch-car-service-ludhiana'],
  ['raymond-tailoring-delhi', 'Raymond Custom Tailoring Studio', 'Arjun Kapoor', '+91 99100 77665', 'arjun.kapoor@techstart.io', 'Looking to schedule master tailor measurement session for 3 bespoke suits and 1 bandhgala.', 'featured', 'new', '/niche/tailorshopnearme/raymond-tailoring-delhi'],
];
for (const l of leads) insertLead.run(...l);

// 10. Crowdsourced Hazards (Safe Alleys & Potholes)
const insertHazard = db.prepare(`
  INSERT OR REPLACE INTO crowdsourced_hazards (slot, threat_kind, severity, address, pincode, lat, lng, description, reporter_contact, upvotes, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const hazards = [
  ['night', 'dark_alley', 4, 'Service lane behind Shivaji Stadium Metro Gate 3', '110001', 28.6341, 77.2185, 'All 4 high-mast streetlights dysfunctional for 2 weeks. Women pedestrians feel unsafe after 8 PM.', 'sneha.d@gmail.com', 18, 'active'],
  ['morning', 'pothole', 4, 'GT Road intersection near Sherpur Chowk Flyover', '141001', 30.8950, 75.8420, 'Deep open crater in left lane causing two-wheelers to swerve dangerously during morning peak hour.', '+91 98765 11223', 34, 'active'],
  ['evening', 'animalAttacks', 3, 'Near Sector 15 Part 2 Market Back Lane', '122001', 28.4610, 77.0310, 'Pack of aggressive stray dogs chasing cyclists and delivery riders after sunset.', 'vikram.r@gurgaon.net', 12, 'investigating'],
  ['midnight', 'robbery', 5, 'Unpatrolled link road connecting Express Highway underpass', '201301', 28.5412, 77.3820, 'Two phone snatching incidents reported this week between 11:30 PM and 1:00 AM. Requires PCR patrol.', 'rwa_sec14@noida.org', 27, 'active'],
  ['noon', 'pothole', 2, 'Koramangala 4th Block 80 Feet Road junction near Sony World', '560034', 12.9340, 77.6260, 'Sunken stormwater drain grate causing sharp bump for auto-rickshaws and low sedans.', 'karthik.m@blr.in', 9, 'resolved'],
];
for (const h of hazards) insertHazard.run(...h);

// 11. Amenity Contributions (Crowdsourced village & local amenities)
const insertContribution = db.prepare(`
  INSERT OR REPLACE INTO amenity_contributions (census_code, locality_name, pincode, amenity_type, facility_name, status, user_comment, photo_url, contributor_name, contributor_contact, upvotes, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const contributions = [
  ['037812', 'Attari Village Border Post', '143108', 'drinking_water', 'RO Clean Drinking Water Chhabeel', 'operational', 'Community RO plant installed by Gram Panchayat, free cold water available for all visitors.', 'https://images.unsplash.com/photo-1544717305-2782549b5136?w=400', 'Gurpreet Singh', '+91 98140 99887', 21, 1],
  ['038945', 'Kila Raipur Stadium Area', '141201', 'street_light', 'Solar High Mast Illumination', 'operational', '8 solar floodlights installed around grounds, very helpful for evening sports practice.', '', 'Manjit Dhillon', '+91 98722 33445', 14, 1],
  ['063821', 'Chhatarpur Bhati Mines Road', '110074', 'ev_charger', 'Tata Power 60kW DC Fast Charger', 'operational', '2 CCS2 guns active 24/7 next to petrol pump with cafe seating.', 'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?w=400', 'Aditya Verma', 'aditya.v@delhiev.org', 31, 1],
  ['092831', 'Marol Fire Brigade Junction', '400059', 'public_toilet', 'BMC Suvidha Sanitation Center', 'operational', 'Clean sanitary complex with disabled access, child nursing room, and card swipe entry.', '', 'Ramesh Chavan', '+91 98201 11223', 25, 1],
];
for (const ac of contributions) insertContribution.run(...ac);

// 12. Submissions (Pending crowdsourced directory submissions)
const insertSubmission = db.prepare(`
  INSERT OR REPLACE INTO submissions (niche_id, place_uid, payload_json, submitted_by, status, remote_id, created_at)
  VALUES ((SELECT id FROM niches WHERE slug = ?), NULL, ?, ?, ?, ?, datetime('now'))
`);
const submissions = [
  ['dhabanearme', JSON.stringify({ name: 'Pal Da Dhaba', category: 'Restaurants', niche: 'dhabanearme', address: 'Near Bus Stand, G.T. Road, Phagwara', pincode: '144401', phone: '+91 1825 260123', description: 'Famous highway stop for butter chicken and tandoori roti.' }), 'kuldeep@gmail.com', 'pending', 'SUBM-2026-001'],
  ['bakerynearme', JSON.stringify({ name: 'Ahdoo\'s Bakery', category: 'Bakery', niche: 'bakerynearme', address: 'Residency Road, Srinagar', pincode: '190001', phone: '+91 194 2472593', description: 'Oldest bakery in Kashmir famed for walnut fudge, almond macaroons and patties.' }), 'tariq.srinagar@gmail.com', 'approved', 'SUBM-2026-002'],
  ['cafenearme', JSON.stringify({ name: 'Glenary\'s Bakery & Cafe', category: 'Cafes', niche: 'cafenearme', address: 'Nehru Road, Darjeeling', pincode: '734101', phone: '+91 354 2254322', description: 'Colonial hill station bakery and cafe with Himalayan views and Darjeeling first flush tea.' }), 'sunita.tamang@darj.in', 'approved', 'SUBM-2026-003'],
  ['carrepairsnearme', JSON.stringify({ name: 'Punjab Auto Electrical Works', category: 'Auto Services', niche: 'carrepairsnearme', address: 'Shop 12, Transport Nagar, Ludhiana', pincode: '141003', phone: '+91 98150 44556', description: 'Specialist in heavy vehicle alternators, starter motors, and commercial truck wiring.' }), 'surjit.singh@yahoo.com', 'pending', 'SUBM-2026-004'],
];
for (const sub of submissions) insertSubmission.run(...sub);

// 13. Claims
const insertClaim = db.prepare(`
  INSERT OR REPLACE INTO claims (business_id, business_name, claimant_name, claimant_phone, claimant_email, business_role, id_proof_url, status)
  VALUES ((SELECT id FROM businesses WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?)
`);
const claims = [
  ['kesar-da-dhaba', 'Kesar Da Dhaba', 'Navpreet Singh', '+91 98141 23456', 'navpreet@kesardadhaba.in', 'Owner (4th Generation)', 'https://storage.vault.local/claims/gst_kesar.pdf', 'verified'],
  ['wengers-deli-bakery', 'Wenger\'s Deli & Bakery', 'Charanjeet Singh', '+91 98102 33403', 'mgmt@wengers.co.in', 'General Manager', 'https://storage.vault.local/claims/wengers_auth.pdf', 'verified'],
  ['blue-tokai-gurgaon', 'Blue Tokai Coffee Roasters', 'Tarun Nayyar', '+91 98214 55012', 'tarun@bluetokaicoffee.com', 'Regional Operations Lead', 'https://storage.vault.local/claims/bt_emp_id.pdf', 'pending'],
];
for (const cl of claims) insertClaim.run(...cl);

console.log('Seeding completed successfully!');
