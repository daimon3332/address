export const countryLanguages = Object.freeze({
  US: ['en'], CA: ['en', 'fr'], MX: ['es'], GB: ['en'], DE: ['de'], FR: ['fr'], IT: ['it'], ES: ['es'], NL: ['nl'],
  RU: ['ru'], JP: ['ja'], HK: ['zh', 'en'], SG: ['en', 'zh', 'ms'], TW: ['zh'], KR: ['ko'], MY: ['ms', 'en'], CN: ['zh'],
  TH: ['th'], PH: ['fil', 'en'], VN: ['vi'], TR: ['tr'], SA: ['ar'], IN: ['en'], AU: ['en'], BR: ['pt'], NG: ['en'], ZA: ['en']
});

export const nonResidentialRules = Object.freeze({
  government: {
    classifications: ['government', 'government_office', 'public_building', 'civic', 'townhall', 'tax_office', 'customs'],
    terms: {
      en: ['government office', 'government building', 'city hall', 'town hall', 'municipal hall', 'county hall', 'embassy', 'consulate', 'ministry', 'finance bureau', 'tax office', 'customs office', 'customs house', 'public service center', 'public service centre'],
      es: ['oficina gubernamental', 'edificio gubernamental', 'ayuntamiento', 'alcaldia', 'municipalidad', 'embajada', 'consulado', 'ministerio'],
      de: ['regierungsgebaude', 'regierungsamt', 'rathaus', 'gemeindeamt', 'botschaft', 'konsulat', 'ministerium'],
      fr: ['bureau gouvernemental', 'batiment gouvernemental', 'hotel de ville', 'mairie', 'prefecture', 'ambassade', 'consulat', 'ministere'],
      it: ['ufficio governativo', 'edificio governativo', 'municipio', 'palazzo comunale', 'ambasciata', 'consolato', 'ministero'],
      nl: ['overheidskantoor', 'overheidsgebouw', 'gemeentehuis', 'stadhuis', 'ambassade', 'consulaat', 'ministerie'],
      ru: ['правительственное учреждение', 'правительственное здание', 'администрация города', 'мэрия', 'посольство', 'консульство', 'министерство'],
      ja: ['市役所', '区役所', '町役場', '村役場', '都道府県庁', '官公庁', '政府機関', '大使館', '領事館', '省庁'],
      zh: ['人民政府', '政府办公室', '政府辦公室', '政府办事处', '政府辦事處', '政府合署', '政府总部', '政府總部', '政府大楼', '政府大樓', '市政厅', '市政廳', '立法会', '立法會', '区议会', '區議會', '民政事务处', '民政事務處', '廉政公署', '行政服务中心', '行政服務中心', '政务服务中心', '政務服務中心', '财政局', '財政局', '财政所', '財政所', '税务局', '稅務局', '海关', '海關', '登记机关', '登記機關', '大使馆', '大使館', '领事馆', '領事館'],
      ko: ['시청', '구청', '군청', '정부청사', '정부기관', '대사관', '영사관'],
      ms: ['pejabat kerajaan', 'bangunan kerajaan', 'dewan bandaraya', 'majlis perbandaran', 'kedutaan', 'konsulat', 'kementerian'],
      th: ['ศาลากลาง', 'ที่ว่าการอำเภอ', 'สำนักงานรัฐบาล', 'สถานทูต', 'สถานกงสุล', 'กระทรวง'],
      fil: ['tanggapan ng pamahalaan', 'gusali ng pamahalaan', 'munisipyo', 'bulwagan ng lungsod', 'embahada', 'konsulado', 'kagawaran'],
      vi: ['ủy ban nhân dân', 'trụ sở chính quyền', 'tòa thị chính', 'đại sứ quán', 'lãnh sự quán'],
      tr: ['belediye binası', 'hükümet konağı', 'devlet dairesi', 'büyükelçilik', 'konsolosluk', 'bakanlık'],
      ar: ['بلدية', 'دار البلدية', 'مكتب حكومي', 'مبنى حكومي', 'سفارة', 'قنصلية', 'وزارة'],
      pt: ['repartição pública', 'edificio governamental', 'prefeitura', 'câmara municipal', 'embaixada', 'consulado', 'ministério']
    }
  },
  military_law_justice: {
    classifications: ['military', 'barracks', 'police', 'prison', 'courthouse', 'court', 'prosecutor', 'detention_centre', 'detention_center'],
    terms: {
      en: ['police station', 'police headquarters', 'sheriff office', 'military base', 'army barracks', 'naval base', 'air force base', 'courthouse', 'court house', 'prosecutor office', 'prosecutor\'s office', 'detention center', 'detention centre', 'correctional facility', 'correctional institution', 'correctional services department', 'reception center', 'reception centre', 'remand center', 'remand centre', 'drug addiction treatment center', 'drug addiction treatment centre', 'rehabilitation center', 'rehabilitation centre', 'halfway house', 'visiting room', 'visit registration room', 'prison'],
      es: ['estacion de policia', 'comisaria', 'cuartel militar', 'base militar', 'palacio de justicia', 'juzgado', 'prision', 'carcel'],
      de: ['polizeiwache', 'polizeiprasidium', 'militarstutzpunkt', 'kaserne', 'gericht', 'justizvollzugsanstalt', 'gefangnis'],
      fr: ['poste de police', 'commissariat', 'base militaire', 'caserne militaire', 'palais de justice', 'tribunal', 'prison'],
      it: ['stazione di polizia', 'questura', 'base militare', 'caserma militare', 'tribunale', 'carcere'],
      nl: ['politiebureau', 'politiekantoor', 'militaire basis', 'kazerne', 'rechtbank', 'gevangenis'],
      ru: ['полицейский участок', 'отдел полиции', 'военная база', 'военная часть', 'суд', 'тюрьма'],
      ja: ['警察署', '交番', '自衛隊基地', '駐屯地', '裁判所', '刑務所'],
      zh: ['警察局', '警署', '警察总部', '警察總部', '派出所', '公安局', '公安厅', '公安廳', '交警支队', '交警支隊', '军事基地', '軍事基地', '军营', '軍營', '法院', '检察院', '檢察院', '惩教署', '懲教署', '惩教所', '懲教所', '惩教院所', '懲教院所', '看守所', '收押所', '拘留所', '羁留所', '羈留所', '羁留中心', '羈留中心', '羁留病房', '羈留病房', '戒毒所', '教导所', '教導所', '劳教中心', '勞教中心', '更生中心', '中途宿舍', '探访室', '探訪室', '探访登记室', '探訪登記室', '监狱', '監獄'],
      ko: ['경찰서', '파출소', '군사기지', '군부대', '법원', '교도소'],
      ms: ['balai polis', 'ibu pejabat polis', 'pangkalan tentera', 'kem tentera', 'mahkamah', 'penjara'],
      th: ['สถานีตำรวจ', 'ฐานทัพ', 'ค่ายทหาร', 'ศาล', 'เรือนจำ'],
      fil: ['himpilan ng pulis', 'kampo militar', 'base militar', 'hukuman', 'bilangguan'],
      vi: ['đồn cảnh sát', 'trụ sở công an', 'căn cứ quân sự', 'doanh trại', 'tòa án', 'nhà tù'],
      tr: ['polis karakolu', 'emniyet müdürlüğü', 'askeri üs', 'kışla', 'adliye', 'mahkeme', 'cezaevi'],
      ar: ['مركز شرطة', 'قسم شرطة', 'قاعدة عسكرية', 'ثكنة عسكرية', 'محكمة', 'سجن'],
      pt: ['delegacia de polícia', 'posto policial', 'base militar', 'quartel militar', 'tribunal', 'fórum', 'prisão']
    }
  },
  education_research: {
    classifications: ['school', 'college', 'university', 'kindergarten', 'research_institute'],
    terms: {
      en: ['elementary school', 'primary school', 'secondary school', 'high school', 'university', 'college', 'kindergarten', 'research institute', 'research center', 'research centre'],
      es: ['escuela primaria', 'escuela secundaria', 'instituto de secundaria', 'universidad', 'colegio', 'jardin de infancia', 'instituto de investigacion', 'centro de investigacion'],
      de: ['grundschule', 'weiterfuhrende schule', 'gymnasium', 'universitat', 'hochschule', 'kindergarten', 'forschungsinstitut', 'forschungszentrum'],
      fr: ['ecole primaire', 'ecole secondaire', 'lycee', 'universite', 'college', 'creche', 'institut de recherche', 'centre de recherche'],
      it: ['scuola primaria', 'scuola secondaria', 'liceo', 'universita', 'collegio', 'asilo', 'istituto di ricerca', 'centro di ricerca'],
      nl: ['basisschool', 'middelbare school', 'universiteit', 'hogeschool', 'kinderdagverblijf', 'onderzoeksinstituut', 'onderzoekscentrum'],
      ru: ['начальная школа', 'средняя школа', 'университет', 'детский сад', 'научно-исследовательский институт', 'исследовательский центр'],
      ja: ['小学校', '中学校', '高等学校', '高校', '大学', '研究所', '研究センター', '幼稚園', '保育園'],
      zh: ['幼儿园', '幼兒園', '幼稚园', '幼稚園', '学校', '學校', '小学', '小學', '中学', '中學', '高中', '职业学校', '職業學校', '学院', '學院', '书院', '書院', '大学', '大學', '校园', '校園', '校舍', '培训中心', '培訓中心', '研究院', '研究所', '科研中心'],
      ko: ['초등학교', '중학교', '고등학교', '대학교', '연구소', '연구센터', '유치원', '어린이집'],
      ms: ['sekolah rendah', 'sekolah menengah', 'universiti', 'kolej', 'institut penyelidikan', 'pusat penyelidikan', 'tadika'],
      th: ['โรงเรียนประถม', 'โรงเรียนมัธยม', 'มหาวิทยาลัย', 'วิทยาลัย', 'สถาบันวิจัย', 'ศูนย์วิจัย', 'โรงเรียนอนุบาล'],
      fil: ['paaralang elementarya', 'mataas na paaralan', 'unibersidad', 'kolehiyo', 'instituto ng pananaliksik', 'sentro ng pananaliksik', 'kindergarten'],
      vi: ['trường tiểu học', 'trường trung học', 'trường đại học', 'trường cao đẳng', 'viện nghiên cứu', 'trung tâm nghiên cứu', 'trường mẫu giáo'],
      tr: ['ilkokul', 'ortaokul', 'lise', 'üniversite', 'kolej', 'araştırma enstitüsü', 'araştırma merkezi', 'anaokulu'],
      ar: ['مدرسة ابتدائية', 'مدرسة ثانوية', 'جامعة', 'كلية', 'معهد أبحاث', 'مركز أبحاث', 'روضة أطفال'],
      pt: ['escola primária', 'escola secundária', 'colégio', 'universidade', 'instituto de pesquisa', 'centro de pesquisa', 'jardim de infância']
    }
  },
  healthcare_care: {
    classifications: ['hospital', 'clinic', 'doctors', 'nursing_home', 'social_facility', 'healthcare', 'pharmacy', 'hospice'],
    terms: {
      en: ['hospital', 'medical center', 'medical centre', 'health center', 'health centre', 'clinic', 'nursing home', 'care home', 'hospice', 'pharmacy'],
      es: ['hospital', 'centro medico', 'centro de salud', 'clinica', 'residencia de ancianos', 'hogar de ancianos', 'hospicio', 'farmacia'],
      de: ['krankenhaus', 'medizinisches zentrum', 'gesundheitszentrum', 'klinik', 'pflegeheim', 'seniorenheim', 'hospiz', 'apotheke'],
      fr: ['hopital', 'centre medical', 'centre de sante', 'clinique', 'maison de retraite', 'ehpad', 'hospice', 'pharmacie'],
      it: ['ospedale', 'centro medico', 'centro sanitario', 'clinica', 'casa di riposo', 'ospizio', 'farmacia'],
      nl: ['ziekenhuis', 'medisch centrum', 'gezondheidscentrum', 'kliniek', 'verpleeghuis', 'verzorgingshuis', 'hospice', 'apotheek'],
      ru: ['больница', 'медицинский центр', 'поликлиника', 'клиника', 'дом престарелых', 'хоспис', 'аптека'],
      ja: ['病院', '医療センター', '診療所', 'クリニック', '介護施設', '老人ホーム', 'ホスピス', '薬局'],
      zh: ['医院', '醫院', '医疗中心', '醫療中心', '诊所', '診所', '医务所', '醫務所', '健康院', '卫生院', '衛生院', '卫生中心', '衛生中心', '衞生中心', '疾控中心', '急救中心', '血站', '疗养院', '療養院', '护理院', '護理院', '护养院', '護養院', '护老院', '護老院', '养老院', '養老院', '安老院', '福利院', '药房', '藥房'],
      ko: ['병원', '의료원', '의료센터', '의원', '요양원', '호스피스', '약국'],
      ms: ['hospital', 'pusat perubatan', 'pusat kesihatan', 'klinik', 'rumah jagaan', 'rumah warga emas', 'hospis', 'farmasi'],
      th: ['โรงพยาบาล', 'ศูนย์การแพทย์', 'ศูนย์สุขภาพ', 'คลินิก', 'บ้านพักคนชรา', 'สถานพยาบาล', 'ฮอสพิซ', 'ร้านขายยา'],
      fil: ['ospital', 'sentrong medikal', 'sentro ng kalusugan', 'klinika', 'tahanan ng matatanda', 'nursing home', 'hospice', 'botika'],
      vi: ['bệnh viện', 'trung tâm y tế', 'phòng khám', 'viện dưỡng lão', 'nhà dưỡng lão', 'nhà tế bần', 'nhà thuốc'],
      tr: ['hastane', 'tıp merkezi', 'sağlık merkezi', 'klinik', 'huzurevi', 'bakım evi', 'darülaceze', 'eczane'],
      ar: ['مستشفى', 'مركز طبي', 'مركز صحي', 'عيادة', 'دار رعاية المسنين', 'دار تمريض', 'دار رعاية', 'صيدلية'],
      pt: ['hospital', 'centro médico', 'centro de saúde', 'clínica', 'lar de idosos', 'casa de repouso', 'hospício', 'farmácia']
    }
  },
  finance: {
    classifications: ['bank', 'central_bank', 'investment_bank', 'credit_union', 'stock_exchange', 'commodity_exchange', 'securities', 'brokerage', 'insurance', 'financial', 'financial_services', 'fund', 'clearing_house', 'financial_regulator', 'pawnbroker'],
    terms: {
      en: ['bank', 'central bank', 'investment bank', 'credit union', 'stock exchange', 'futures exchange', 'commodity exchange', 'securities company', 'brokerage', 'insurance company', 'insurance office', 'fund company', 'asset management', 'wealth management', 'clearing house', 'clearing center', 'clearing centre', 'financial center', 'financial centre', 'financial services center', 'financial services centre', 'monetary authority', 'financial regulator', 'pawn shop', 'pawnbroker'],
      es: ['banco', 'banco central', 'banco de inversion', 'cooperativa de credito', 'bolsa de valores', 'centro financiero', 'autoridad monetaria', 'regulador financiero', 'compania de seguros', 'oficina de seguros'],
      de: ['bank', 'zentralbank', 'investmentbank', 'sparkasse', 'kreditgenossenschaft', 'borse', 'finanzzentrum', 'finanzaufsicht', 'versicherungsgesellschaft', 'versicherungsburo'],
      fr: ['banque', 'banque centrale', 'banque investissement', 'caisse de credit', 'bourse', 'centre financier', 'autorite monetaire', 'regulateur financier', 'compagnie assurance', 'bureau assurance'],
      it: ['banca', 'banca centrale', 'banca investimento', 'unione di credito', 'borsa valori', 'centro finanziario', 'autorita monetaria', 'compagnia di assicurazioni', 'ufficio assicurativo'],
      nl: ['bank', 'centrale bank', 'investeringsbank', 'kredietunie', 'effectenbeurs', 'financieel centrum', 'financiele toezichthouder', 'verzekeringsmaatschappij', 'verzekeringskantoor'],
      ru: ['банк', 'центральный банк', 'инвестиционный банк', 'кредитный союз', 'фондовая биржа', 'финансовый центр', 'финансовый регулятор', 'страховая компания', 'страховой офис'],
      ja: ['銀行', '中央銀行', '投資銀行', '信用金庫', '証券取引所', '商品取引所', '証券会社', '金融センター', '金融庁', '保険会社'],
      zh: ['银行', '銀行', '中央银行', '中央銀行', '投资银行', '投資銀行', '信用社', '证券交易所', '證券交易所', '期货交易所', '期貨交易所', '商品交易所', '证券公司', '證券公司', '保险公司', '保險公司', '基金公司', '资产管理公司', '資產管理公司', '财富管理中心', '財富管理中心', '清算中心', '结算中心', '結算中心', '典当行', '典當行', '金融中心', '金融服务中心', '金融服務中心', '金融管理局', '金融监管局', '金融監管局', '货币管理局', '貨幣管理局'],
      ko: ['은행', '중앙은행', '투자은행', '신용협동조합', '증권거래소', '증권회사', '금융센터', '금융감독원', '보험회사'],
      ms: ['bank', 'bank pusat', 'bank pelaburan', 'kesatuan kredit', 'bursa saham', 'pusat kewangan', 'pengawal selia kewangan', 'syarikat sekuriti', 'syarikat insurans'],
      th: ['ธนาคาร', 'ธนาคารกลาง', 'ธนาคารเพื่อการลงทุน', 'สหกรณ์เครดิต', 'ตลาดหลักทรัพย์', 'ศูนย์การเงิน', 'หน่วยงานกำกับดูแลทางการเงิน', 'บริษัทหลักทรัพย์', 'บริษัทประกันภัย'],
      fil: ['bangko', 'bangko sentral', 'investment bank', 'credit union', 'stock exchange', 'sentro ng pananalapi', 'financial regulator', 'kompanya ng securities', 'kompanya ng seguro'],
      vi: ['ngân hàng', 'ngân hàng trung ương', 'ngân hàng đầu tư', 'liên minh tín dụng', 'sở giao dịch chứng khoán', 'trung tâm tài chính', 'cơ quan quản lý tài chính', 'công ty chứng khoán', 'công ty bảo hiểm'],
      tr: ['banka', 'merkez bankası', 'yatırım bankası', 'kredi birliği', 'borsa', 'finans merkezi', 'finansal düzenleyici', 'menkul kıymetler şirketi', 'sigorta şirketi'],
      ar: ['بنك', 'بنك مركزي', 'بنك استثماري', 'اتحاد ائتماني', 'بورصة', 'مركز مالي', 'هيئة النقد', 'هيئة الرقابة المالية', 'شركة أوراق مالية', 'شركة تأمين'],
      pt: ['banco', 'banco central', 'banco de investimento', 'cooperativa de crédito', 'bolsa de valores', 'centro financeiro', 'autoridade monetária', 'regulador financeiro', 'corretora de valores', 'seguradora']
    }
  },
  fire_utilities: {
    classifications: ['fire_station', 'power_station', 'substation', 'water_works', 'wastewater_plant', 'utility'],
    terms: {
      en: ['fire station', 'fire department', 'power station', 'power plant', 'electrical substation', 'water treatment plant', 'sewage treatment plant', 'wastewater plant', 'utility office'],
      es: ['estacion de bomberos', 'parque de bomberos', 'central electrica', 'subestacion electrica', 'planta de tratamiento de agua', 'planta de aguas residuales', 'servicios publicos'],
      de: ['feuerwache', 'feuerwehrhaus', 'kraftwerk', 'umspannwerk', 'wasserwerk', 'klaranlage', 'versorgungsbetrieb'],
      fr: ['caserne de pompiers', 'centre de secours', 'centrale electrique', 'poste electrique', 'usine de traitement des eaux', 'station epuration', 'service public'],
      it: ['caserma dei vigili del fuoco', 'centrale elettrica', 'sottostazione elettrica', 'impianto di trattamento delle acque', 'depuratore', 'servizio pubblico'],
      nl: ['brandweerkazerne', 'elektriciteitscentrale', 'onderstation', 'waterzuiveringsinstallatie', 'rioolwaterzuivering', 'nutsbedrijf'],
      ru: ['пожарная часть', 'электростанция', 'подстанция', 'водоочистная станция', 'очистные сооружения', 'коммунальная служба'],
      ja: ['消防署', '発電所', '変電所', '浄水場', '下水処理場', '公益事業所'],
      zh: ['消防局', '消防站', '消防救援', '消防大队', '消防大隊', '消防支队', '消防支隊', '救援支队', '救援支隊', '救援大队', '救援大隊', '应急中心', '應急中心', '应急管理', '應急管理', '发电厂', '發電廠', '变电站', '變電站', '水厂', '水廠', '燃气站', '燃氣站', '污水处理厂', '污水處理廠', '垃圾处理厂', '垃圾處理廠', '公用事业局', '公用事業局'],
      ko: ['소방서', '발전소', '변전소', '정수장', '하수처리장', '공공사업소'],
      ms: ['balai bomba', 'stesen janakuasa', 'pencawang elektrik', 'loji rawatan air', 'loji rawatan kumbahan', 'utiliti awam'],
      th: ['สถานีดับเพลิง', 'โรงไฟฟ้า', 'สถานีไฟฟ้าย่อย', 'โรงงานบำบัดน้ำ', 'โรงบำบัดน้ำเสีย', 'สาธารณูปโภค'],
      fil: ['himpilan ng bumbero', 'planta ng kuryente', 'electrical substation', 'planta ng tubig', 'planta ng wastewater', 'public utility'],
      vi: ['trạm cứu hỏa', 'nhà máy điện', 'trạm biến áp', 'nhà máy xử lý nước', 'nhà máy xử lý nước thải', 'công ty tiện ích'],
      tr: ['itfaiye istasyonu', 'elektrik santrali', 'trafo merkezi', 'su arıtma tesisi', 'atıksu arıtma tesisi', 'kamu hizmeti'],
      ar: ['محطة إطفاء', 'محطة كهرباء', 'محطة فرعية', 'محطة معالجة مياه', 'محطة معالجة مياه الصرف', 'مرفق عام'],
      pt: ['quartel de bombeiros', 'corpo de bombeiros', 'usina elétrica', 'subestação', 'estação de tratamento de água', 'estação de tratamento de esgoto', 'serviço público']
    }
  },
  transport_logistics: {
    classifications: ['train_station', 'bus_station', 'airport', 'port_terminal', 'warehouse', 'logistics', 'depot', 'freight_terminal'],
    terms: {
      en: ['railway station', 'train station', 'bus station', 'bus terminal', 'airport', 'port terminal', 'freight terminal', 'logistics center', 'logistics centre', 'distribution center', 'distribution centre', 'warehouse', 'depot'],
      es: ['estacion de tren', 'estacion ferroviaria', 'estacion de autobuses', 'terminal de autobuses', 'aeropuerto', 'terminal portuaria', 'terminal de carga', 'centro logistico', 'centro de distribucion', 'almacen', 'deposito'],
      de: ['bahnhof', 'busbahnhof', 'flughafen', 'hafenterminal', 'guterbahnhof', 'logistikzentrum', 'verteilzentrum', 'lagerhaus', 'depot'],
      fr: ['gare ferroviaire', 'gare routiere', 'aeroport', 'terminal portuaire', 'terminal de fret', 'centre logistique', 'centre de distribution', 'entrepot', 'depot'],
      it: ['stazione ferroviaria', 'stazione degli autobus', 'aeroporto', 'terminal portuale', 'terminal merci', 'centro logistico', 'centro di distribuzione', 'magazzino', 'deposito'],
      nl: ['treinstation', 'busstation', 'luchthaven', 'haventerminal', 'vrachtterminal', 'logistiek centrum', 'distributiecentrum', 'magazijn', 'depot'],
      ru: ['железнодорожный вокзал', 'автовокзал', 'аэропорт', 'портовый терминал', 'грузовой терминал', 'логистический центр', 'распределительный центр', 'склад', 'депо'],
      ja: ['鉄道駅', 'バスターミナル', '空港', '港湾ターミナル', '貨物ターミナル', '物流センター', '配送センター', '倉庫', '車庫'],
      zh: ['火车站', '火車站', '汽车站', '汽車站', '客运站', '客運站', '机场', '機場', '港口码头', '港口碼頭', '高速服务区', '高速服務區', '货运站', '貨運站', '物流园', '物流園', '物流中心', '配送中心', '仓库', '倉庫'],
      ko: ['기차역', '철도역', '버스터미널', '공항', '항만터미널', '화물터미널', '물류센터', '배송센터', '창고'],
      ms: ['stesen kereta api', 'stesen bas', 'terminal bas', 'lapangan terbang', 'terminal pelabuhan', 'terminal kargo', 'pusat logistik', 'pusat pengedaran', 'gudang', 'depot'],
      th: ['สถานีรถไฟ', 'สถานีขนส่ง', 'สนามบิน', 'ท่าเรือ', 'สถานีขนส่งสินค้า', 'ศูนย์โลจิสติกส์', 'ศูนย์กระจายสินค้า', 'คลังสินค้า'],
      fil: ['estasyon ng tren', 'terminal ng bus', 'paliparan', 'terminal ng pantalan', 'terminal ng kargamento', 'sentro ng logistics', 'sentro ng distribusyon', 'bodega', 'depot'],
      vi: ['ga tàu', 'ga đường sắt', 'bến xe', 'sân bay', 'cảng hàng hóa', 'nhà ga hàng hóa', 'trung tâm hậu cần', 'trung tâm phân phối', 'nhà kho', 'kho vận'],
      tr: ['tren istasyonu', 'otobüs terminali', 'havalimanı', 'liman terminali', 'yük terminali', 'lojistik merkezi', 'dağıtım merkezi', 'depo', 'antrepo'],
      ar: ['محطة قطار', 'محطة حافلات', 'مطار', 'محطة ميناء', 'محطة شحن', 'مركز لوجستي', 'مركز توزيع', 'مستودع'],
      pt: ['estação ferroviária', 'estação de trem', 'rodoviária', 'aeroporto', 'terminal portuário', 'terminal de carga', 'centro logístico', 'centro de distribuição', 'armazém', 'depósito']
    }
  },
  religious_funeral_public: {
    classifications: ['church', 'mosque', 'temple', 'synagogue', 'religious', 'place_of_worship', 'cemetery', 'grave_yard', 'crematorium', 'funeral_home', 'funeral_directors', 'library', 'museum', 'theatre', 'cinema', 'arts_centre', 'stadium', 'community_centre', 'social_centre', 'conference_centre'],
    terms: {
      en: ['church', 'mosque', 'temple', 'synagogue', 'monastery', 'convent', 'cemetery', 'crematorium', 'funeral home', 'community center', 'community centre', 'library', 'museum', 'theatre', 'theater', 'stadium', 'arena', 'convention center', 'convention centre', 'exhibition center', 'exhibition centre'],
      es: ['iglesia', 'mezquita', 'templo', 'sinagoga', 'monasterio', 'convento', 'cementerio', 'crematorio', 'funeraria', 'centro comunitario', 'biblioteca', 'museo', 'teatro', 'estadio', 'centro de convenciones'],
      de: ['kirche', 'moschee', 'tempel', 'synagoge', 'kloster', 'friedhof', 'krematorium', 'bestattungsinstitut', 'gemeindezentrum', 'bibliothek', 'museum', 'theater', 'stadion', 'kongresszentrum'],
      fr: ['eglise', 'mosquee', 'temple', 'synagogue', 'monastere', 'couvent', 'cimetiere', 'crematorium', 'pompes funebres', 'centre communautaire', 'bibliotheque', 'musee', 'theatre', 'stade', 'centre de congres'],
      it: ['chiesa', 'moschea', 'tempio', 'sinagoga', 'monastero', 'convento', 'cimitero', 'crematorio', 'pompe funebri', 'centro comunitario', 'biblioteca', 'museo', 'teatro', 'stadio', 'centro congressi'],
      nl: ['kerk', 'moskee', 'tempel', 'synagoge', 'klooster', 'begraafplaats', 'crematorium', 'uitvaartcentrum', 'buurthuis', 'bibliotheek', 'museum', 'theater', 'stadion', 'congrescentrum'],
      ru: ['церковь', 'мечеть', 'храм', 'синагога', 'монастырь', 'кладбище', 'крематорий', 'похоронное бюро', 'общественный центр', 'библиотека', 'музей', 'театр', 'стадион', 'конгресс-центр'],
      ja: ['教会', 'モスク', '寺院', '神社', 'シナゴーグ', '修道院', '墓地', '火葬場', '葬儀場', '図書館', '博物館', '美術館', '劇場', '競技場', '公民館', '展示場'],
      zh: ['教堂', '清真寺', '寺庙', '寺廟', '道观', '道觀', '犹太会堂', '猶太會堂', '修道院', '公墓', '陵园', '陵園', '火葬场', '火葬場', '殡仪馆', '殯儀館', '图书馆', '圖書館', '博物馆', '博物館', '剧院', '劇院', '体育馆', '體育館', '会展中心', '會展中心', '社区中心', '社區中心'],
      ko: ['교회', '성당', '사찰', '모스크', '시나고그', '수도원', '묘지', '화장장', '장례식장', '도서관', '박물관', '극장', '경기장', '주민센터', '전시장'],
      ms: ['gereja', 'masjid', 'kuil', 'sinagog', 'biara', 'tanah perkuburan', 'krematorium', 'rumah pengebumian', 'pusat komuniti', 'perpustakaan', 'muzium', 'teater', 'stadium', 'pusat konvensyen'],
      th: ['โบสถ์', 'มัสยิด', 'วัด', 'สุเหร่ายิว', 'อาราม', 'สุสาน', 'เมรุ', 'สถานฌาปนกิจ', 'ห้องสมุด', 'พิพิธภัณฑ์', 'โรงละคร', 'สนามกีฬา', 'ศูนย์ชุมชน', 'ศูนย์ประชุม'],
      fil: ['simbahan', 'moske', 'templo', 'sinagoga', 'monasteryo', 'sementeryo', 'krematoryo', 'punerarya', 'sentro ng komunidad', 'aklatan', 'museo', 'teatro', 'stadium', 'convention center'],
      vi: ['nhà thờ', 'nhà thờ hồi giáo', 'chùa', 'giáo đường do thái', 'tu viện', 'nghĩa trang', 'đài hóa thân', 'nhà tang lễ', 'thư viện', 'bảo tàng', 'nhà hát', 'sân vận động', 'trung tâm cộng đồng', 'trung tâm hội nghị'],
      tr: ['kilise', 'cami', 'tapınak', 'sinagog', 'manastır', 'mezarlık', 'krematoryum', 'cenaze evi', 'toplum merkezi', 'kütüphane', 'müze', 'tiyatro', 'stadyum', 'kongre merkezi'],
      ar: ['كنيسة', 'مسجد', 'معبد', 'كنيس', 'دير', 'مقبرة', 'محرقة', 'دار جنازة', 'مكتبة', 'متحف', 'مسرح', 'ملعب', 'مركز مجتمعي', 'مركز مؤتمرات'],
      pt: ['igreja', 'mesquita', 'templo', 'sinagoga', 'mosteiro', 'cemitério', 'crematório', 'funerária', 'centro comunitário', 'biblioteca', 'museu', 'teatro', 'estádio', 'centro de convenções']
    }
  },
  hospitality_commercial_industrial: {
    classifications: ['hotel', 'hostel', 'motel', 'guest_house', 'guesthouse', 'resort', 'mall', 'retail', 'shop', 'supermarket', 'marketplace', 'office', 'commercial', 'industrial', 'factory', 'dormitory'],
    terms: {
      en: ['hotel', 'hostel', 'motel', 'resort', 'shopping mall', 'shopping center', 'shopping centre', 'office building', 'office tower', 'business center', 'business centre', 'factory', 'industrial park', 'student dormitory', 'staff dormitory', 'workers dormitory'],
      es: ['hotel', 'hostal', 'motel', 'complejo turistico', 'centro comercial', 'edificio de oficinas', 'torre de oficinas', 'centro de negocios', 'fabrica', 'parque industrial', 'residencia estudiantil', 'dormitorio estudiantil'],
      de: ['hotel', 'hostel', 'motel', 'ferienanlage', 'einkaufszentrum', 'burogebaude', 'buroturm', 'geschaftszentrum', 'fabrik', 'industriepark', 'studentenwohnheim', 'mitarbeiterwohnheim'],
      fr: ['hotel', 'auberge', 'motel', 'complexe touristique', 'centre commercial', 'immeuble de bureaux', 'tour de bureaux', 'centre affaires', 'usine', 'parc industriel', 'residence universitaire', 'dortoir etudiant'],
      it: ['hotel', 'albergo', 'ostello', 'motel', 'resort', 'centro commerciale', 'edificio per uffici', 'torre per uffici', 'centro direzionale', 'fabbrica', 'parco industriale', 'dormitorio studentesco'],
      nl: ['hotel', 'hostel', 'motel', 'vakantieoord', 'winkelcentrum', 'kantoorgebouw', 'kantoortoren', 'zakencentrum', 'fabriek', 'industrieterrein', 'studentenhuisvesting', 'studentenflat'],
      ru: ['гостиница', 'отель', 'хостел', 'мотель', 'курорт', 'торговый центр', 'офисное здание', 'бизнес-центр', 'завод', 'фабрика', 'промышленный парк', 'студенческое общежитие', 'общежитие для сотрудников'],
      ja: ['ホテル', 'ホステル', '旅館', 'リゾート', 'ショッピングモール', '商業施設', 'オフィスビル', '事務所ビル', '工場', '工業団地', '学生寮', '社員寮'],
      zh: ['酒店', '宾馆', '賓館', '旅馆', '旅館', '青年旅舍', '购物中心', '購物中心', '商场', '商場', '写字楼', '寫字樓', '办公楼', '辦公樓', '办公大厦', '辦公大廈', '工厂', '工廠', '工业园', '工業園', '产业园', '產業園', '学生宿舍', '學生宿舍', '员工宿舍', '員工宿舍', '职工宿舍', '職工宿舍', '停车场', '停車場'],
      ko: ['호텔', '모텔', '호스텔', '리조트', '쇼핑몰', '쇼핑센터', '오피스빌딩', '사무실빌딩', '비즈니스센터', '공장', '산업단지', '학생기숙사', '직원기숙사'],
      ms: ['hotel', 'asrama', 'motel', 'resort', 'pusat membeli-belah', 'bangunan pejabat', 'menara pejabat', 'pusat perniagaan', 'kilang', 'taman perindustrian', 'asrama pelajar', 'asrama pekerja'],
      th: ['โรงแรม', 'โฮสเทล', 'โมเทล', 'รีสอร์ท', 'ศูนย์การค้า', 'อาคารสำนักงาน', 'อาคารธุรกิจ', 'โรงงาน', 'นิคมอุตสาหกรรม', 'หอพักนักศึกษา', 'หอพักพนักงาน'],
      fil: ['hotel', 'hostel', 'motel', 'resort', 'shopping center', 'mall', 'gusaling opisina', 'sentro ng negosyo', 'pabrika', 'industrial park', 'dormitoryo ng mag-aaral', 'dormitoryo ng empleyado'],
      vi: ['khách sạn', 'nhà nghỉ', 'nhà trọ tập thể', 'khu nghỉ dưỡng', 'trung tâm mua sắm', 'tòa nhà văn phòng', 'trung tâm kinh doanh', 'nhà máy', 'khu công nghiệp', 'ký túc xá sinh viên', 'ký túc xá nhân viên'],
      tr: ['otel', 'hostel', 'motel', 'tatil köyü', 'alışveriş merkezi', 'ofis binası', 'iş merkezi', 'fabrika', 'sanayi sitesi', 'öğrenci yurdu', 'personel yurdu'],
      ar: ['فندق', 'نزل', 'موتيل', 'منتجع', 'مركز تسوق', 'مبنى مكاتب', 'برج مكاتب', 'مركز أعمال', 'مصنع', 'منطقة صناعية', 'سكن طلاب', 'سكن موظفين'],
      pt: ['hotel', 'pousada', 'hostel', 'motel', 'resort', 'shopping center', 'centro comercial', 'prédio de escritórios', 'centro empresarial', 'fábrica', 'parque industrial', 'alojamento estudantil', 'dormitório estudantil']
    }
  },
  localCommerce: {
    classifications: [],
    terms: {
      en: ['barber shop', 'hair salon', 'beauty salon', 'nail salon', 'convenience store', 'supermarket', 'restaurant', 'canteen', 'internet cafe', 'karaoke', 'gas station', 'petrol station', 'charging station', 'car wash', 'auto repair', 'sales office', 'laundromat', 'pet shop', 'veterinary clinic', 'wholesale market', 'farmers market'],
      fr: ['salon de coiffure', 'salon de beauté', 'supérette', 'supermarché', 'restaurant', 'cantine', 'station-service', 'lavage auto', 'garage automobile', 'bureau de vente', 'laverie', 'animalerie', 'clinique vétérinaire', 'marché de gros'],
      es: ['peluquería', 'salón de belleza', 'tienda de conveniencia', 'supermercado', 'restaurante', 'cantina', 'gasolinera', 'lavado de autos', 'taller mecánico', 'oficina de ventas', 'lavandería', 'tienda de mascotas', 'clínica veterinaria', 'mercado mayorista'],
      de: ['friseursalon', 'schönheitssalon', 'supermarkt', 'restaurant', 'kantine', 'tankstelle', 'autowaschanlage', 'autowerkstatt', 'verkaufsbüro', 'waschsalon', 'tierhandlung', 'tierklinik', 'großmarkt'],
      it: ['parrucchiere', 'salone di bellezza', 'supermercato', 'ristorante', 'mensa', 'stazione di servizio', 'autolavaggio', 'officina meccanica', 'ufficio vendite', 'lavanderia', 'negozio di animali', 'clinica veterinaria', 'mercato all\'ingrosso'],
      nl: ['kapsalon', 'schoonheidssalon', 'supermarkt', 'restaurant', 'kantine', 'tankstation', 'autowasstraat', 'autogarage', 'verkoopkantoor', 'wasserette', 'dierenwinkel', 'dierenkliniek', 'groothandelsmarkt'],
      ru: ['парикмахерская', 'салон красоты', 'супермаркет', 'ресторан', 'столовая', 'автозаправка', 'автомойка', 'автосервис', 'офис продаж', 'прачечная', 'зоомагазин', 'ветеринарная клиника', 'оптовый рынок'],
      ja: ['理髪店', '美容室', 'コンビニ', 'スーパーマーケット', 'レストラン', '食堂', 'ガソリンスタンド', '洗車場', '自動車整備', '販売事務所', 'コインランドリー', 'ペットショップ', '動物病院', '卸売市場'],
      zh: [
        '有限公司', '股份公司', '有限责任公司', '有限責任公司', '集团公司', '集團公司', '公司',
        '超市', '便利店', '商店', '商铺', '商鋪', '商行', '专卖店', '專賣店', '旗舰店', '旗艦店', '门市部', '門市部',
        '菜市场', '菜市場', '农贸市场', '農貿市場', '批发市场', '批發市場', '建材市场', '建材市場', '商贸城', '商貿城', '家具城',
        '餐厅', '餐廳', '饭店', '飯店', '酒楼', '酒樓', '饭馆', '飯館', '快餐店', '小吃店', '火锅店', '火鍋店', '烧烤店', '燒烤店', '面馆', '麵館', '奶茶店', '咖啡馆', '咖啡館', '茶楼', '茶樓', '食堂',
        '理发店', '理髮店', '美发店', '美髮店', '发廊', '髮廊', '美容院', '美甲店', '养生馆', '養生館', '足疗店', '足療店', '按摩店', '洗浴中心', '影楼', '影樓', '照相馆', '照相館', '干洗店', '乾洗店', '洗衣店',
        '宠物店', '寵物店', '宠物医院', '寵物醫院', '兽医站', '獸醫站',
        '网吧', '網吧', 'KTV', '歌厅', '歌廳', '棋牌室', '游戏厅', '遊戲廳', '健身房', '台球厅', '檯球廳', '电影院', '電影院', '影城', '游泳馆', '游泳館',
        '加油站', '加气站', '加氣站', '充电站', '充電站', '4S店', '汽修厂', '汽修廠', '汽车维修', '汽車維修', '洗车行', '洗車行', '洗车店', '洗車店',
        '邮局', '郵局', '邮政支局', '郵政支局', '快递点', '快遞點', '快递驿站', '快遞驛站', '菜鸟驿站', '菜鳥驛站', '营业厅', '營業廳',
        '售楼处', '售樓處', '售楼部', '售樓部', '营销中心', '營銷中心',
        '加工厂', '加工廠', '车间', '車間', '厂房', '廠房', '厂区', '廠區', '养殖场', '養殖場', '屠宰场', '屠宰場',
        '居委会', '居委會', '村委会', '村委會', '街道办事处', '街道辦事處', '管委会', '管委會', '供电所', '供電所', '供销社', '供銷社', '合作社', '收费站', '收費站', '检测站', '檢測站', '气象站', '氣象站',
        '门诊部', '門診部', '卫生室', '衛生室', '卫生所', '衛生所', '体检中心', '體檢中心', '药店', '藥店', '大药房', '大藥房',
        '招待所', '客栈', '客棧', '民宿', '度假村'
      ],
      ko: ['이발소', '미용실', '편의점', '슈퍼마켓', '식당', '레스토랑', '주유소', '세차장', '자동차정비소', '분양사무소', '빨래방', '애견샵', '동물병원', '도매시장'],
      ms: ['kedai gunting rambut', 'salun kecantikan', 'kedai runcit', 'pasar raya', 'restoran', 'kantin', 'stesen minyak', 'cuci kereta', 'bengkel kereta', 'pejabat jualan', 'kedai dobi', 'kedai haiwan', 'klinik veterinar', 'pasar borong'],
      th: ['ร้านตัดผม', 'ร้านเสริมสวย', 'ร้านสะดวกซื้อ', 'ซูเปอร์มาร์เก็ต', 'ร้านอาหาร', 'โรงอาหาร', 'ปั๊มน้ำมัน', 'คาร์แคร์', 'อู่ซ่อมรถ', 'สำนักงานขาย', 'ร้านซักรีด', 'ร้านสัตว์เลี้ยง', 'คลินิกสัตวแพทย์', 'ตลาดค้าส่ง'],
      fil: ['barberya', 'beauty salon', 'convenience store', 'supermarket', 'restawran', 'kantina', 'gasolinahan', 'car wash', 'talyer ng sasakyan', 'sales office', 'labahan', 'pet shop', 'beterinaryo', 'pamilihang bagsakan'],
      vi: ['tiệm cắt tóc', 'thẩm mỹ viện', 'cửa hàng tiện lợi', 'siêu thị', 'nhà hàng', 'căng tin', 'trạm xăng', 'rửa xe', 'gara ô tô', 'văn phòng bán hàng', 'tiệm giặt ủi', 'cửa hàng thú cưng', 'phòng khám thú y', 'chợ đầu mối'],
      tr: ['berber', 'kuaför', 'güzellik salonu', 'bakkal', 'süpermarket', 'restoran', 'yemekhane', 'benzin istasyonu', 'oto yıkama', 'oto tamirhanesi', 'satış ofisi', 'çamaşırhane', 'pet shop', 'veteriner kliniği', 'toptancı hali'],
      ar: ['صالون حلاقة', 'صالون تجميل', 'متجر صغير', 'سوبر ماركت', 'مطعم', 'مقصف', 'محطة وقود', 'مغسلة سيارات', 'ورشة سيارات', 'مكتب مبيعات', 'مغسلة ملابس', 'متجر حيوانات', 'عيادة بيطرية', 'سوق الجملة'],
      pt: ['barbearia', 'salão de beleza', 'loja de conveniência', 'supermercado', 'restaurante', 'cantina', 'posto de gasolina', 'lava-rápido', 'oficina mecânica', 'escritório de vendas', 'lavanderia', 'pet shop', 'clínica veterinária', 'mercado atacadista']
    }
  }
});
