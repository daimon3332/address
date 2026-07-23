import type { CountryCode } from './types';

// Language spoken natively per supported country (profile-value display only).
const countryLanguage: Record<CountryCode, string> = {
  US: 'en', CA: 'en', GB: 'en', AU: 'en', SG: 'en', NG: 'en', ZA: 'en', IN: 'en', PH: 'en',
  CN: 'zh', HK: 'zh', TW: 'zh',
  JP: 'ja', KR: 'ko', DE: 'de', FR: 'fr', IT: 'it', ES: 'es', MX: 'es', NL: 'nl',
  RU: 'ru', BR: 'pt', TH: 'th', VN: 'vi', TR: 'tr', SA: 'ar', MY: 'ms'
};

// Native translations for the closed profile enum values. Keys are the stored English values.
// Languages: ja ko de fr es it nl ru pt th vi tr ar ms. en/zh come from extensionValueLabels.
const nativeLabels: Record<string, Record<string, string>> = {
  mr: { ja: 'ミスター', ko: '미스터', de: 'Herr', fr: 'M.', es: 'Sr.', it: 'Sig.', nl: 'Dhr.', ru: 'Г-н', pt: 'Sr.', th: 'นาย', vi: 'Ông', tr: 'Bay', ar: 'السيد', ms: 'Encik' },
  ms: { ja: 'ミズ', ko: '미즈', de: 'Frau', fr: 'Mme', es: 'Sra.', it: 'Sig.ra', nl: 'Mevr.', ru: 'Г-жа', pt: 'Sra.', th: 'นางสาว', vi: 'Bà', tr: 'Bayan', ar: 'السيدة', ms: 'Puan' },
  secondary: { ja: '高等学校卒', ko: '고등학교 졸업', de: 'Sekundarschule', fr: 'École secondaire', es: 'Educación secundaria', it: 'Scuola secondaria', nl: 'Middelbare school', ru: 'Среднее образование', pt: 'Ensino médio', th: 'มัธยมศึกษา', vi: 'Trung học phổ thông', tr: 'Lise', ar: 'التعليم الثانوي', ms: 'Sekolah menengah' },
  associate: { ja: '短期大学卒', ko: '전문학사', de: 'Fachschulabschluss', fr: 'Diplôme technique', es: 'Título técnico', it: 'Diploma tecnico', nl: 'Associate degree', ru: 'Среднее специальное', pt: 'Curso técnico', th: 'อนุปริญญา', vi: 'Cao đẳng', tr: 'Ön lisans', ar: 'دبلوم متوسط', ms: 'Diploma' },
  bachelor: { ja: '学士', ko: '학사', de: 'Bachelor', fr: 'Licence', es: 'Licenciatura', it: 'Laurea triennale', nl: 'Bachelor', ru: 'Бакалавр', pt: 'Bacharelado', th: 'ปริญญาตรี', vi: 'Cử nhân', tr: 'Lisans', ar: 'بكالوريوس', ms: 'Ijazah sarjana muda' },
  master: { ja: '修士', ko: '석사', de: 'Master', fr: 'Master', es: 'Maestría', it: 'Laurea magistrale', nl: 'Master', ru: 'Магистр', pt: 'Mestrado', th: 'ปริญญาโท', vi: 'Thạc sĩ', tr: 'Yüksek lisans', ar: 'ماجستير', ms: 'Ijazah sarjana' },
  doctorate: { ja: '博士', ko: '박사', de: 'Doktortitel', fr: 'Doctorat', es: 'Doctorado', it: 'Dottorato', nl: 'Doctoraat', ru: 'Доктор наук', pt: 'Doutorado', th: 'ปริญญาเอก', vi: 'Tiến sĩ', tr: 'Doktora', ar: 'دكتوراه', ms: 'Kedoktoran' },
  employed: { ja: '在職中', ko: '재직 중', de: 'Angestellt', fr: 'Salarié', es: 'Empleado', it: 'Occupato', nl: 'In loondienst', ru: 'Работает', pt: 'Empregado', th: 'มีงานทำ', vi: 'Đang đi làm', tr: 'Çalışıyor', ar: 'موظف', ms: 'Bekerja' },
  'self-employed': { ja: '自営業', ko: '자영업', de: 'Selbstständig', fr: 'Indépendant', es: 'Autónomo', it: 'Lavoratore autonomo', nl: 'Zelfstandig', ru: 'Самозанятый', pt: 'Autônomo', th: 'อาชีพอิสระ', vi: 'Tự kinh doanh', tr: 'Serbest çalışan', ar: 'عمل حر', ms: 'Bekerja sendiri' },
  student: { ja: '学生', ko: '학생', de: 'Student', fr: 'Étudiant', es: 'Estudiante', it: 'Studente', nl: 'Student', ru: 'Студент', pt: 'Estudante', th: 'นักศึกษา', vi: 'Sinh viên', tr: 'Öğrenci', ar: 'طالب', ms: 'Pelajar' },
  'between-jobs': { ja: '求職中', ko: '구직 중', de: 'Arbeitssuchend', fr: 'En recherche d’emploi', es: 'En búsqueda de empleo', it: 'In cerca di lavoro', nl: 'Werkzoekend', ru: 'В поиске работы', pt: 'Em busca de emprego', th: 'กำลังหางาน', vi: 'Đang tìm việc', tr: 'İş arıyor', ar: 'يبحث عن عمل', ms: 'Mencari kerja' },
  retired: { ja: '退職済み', ko: '은퇴', de: 'Im Ruhestand', fr: 'Retraité', es: 'Jubilado', it: 'In pensione', nl: 'Gepensioneerd', ru: 'На пенсии', pt: 'Aposentado', th: 'เกษียณ', vi: 'Đã nghỉ hưu', tr: 'Emekli', ar: 'متقاعد', ms: 'Bersara' },
  'full-time': { ja: 'フルタイム', ko: '풀타임', de: 'Vollzeit', fr: 'Temps plein', es: 'Tiempo completo', it: 'Tempo pieno', nl: 'Voltijd', ru: 'Полная занятость', pt: 'Tempo integral', th: 'เต็มเวลา', vi: 'Toàn thời gian', tr: 'Tam zamanlı', ar: 'دوام كامل', ms: 'Sepenuh masa' },
  'part-time': { ja: 'パートタイム', ko: '파트타임', de: 'Teilzeit', fr: 'Temps partiel', es: 'Tiempo parcial', it: 'Part-time', nl: 'Deeltijd', ru: 'Частичная занятость', pt: 'Meio período', th: 'พาร์ทไทม์', vi: 'Bán thời gian', tr: 'Yarı zamanlı', ar: 'دوام جزئي', ms: 'Separuh masa' },
  capricorn: { ja: '山羊座', ko: '염소자리', de: 'Steinbock', fr: 'Capricorne', es: 'Capricornio', it: 'Capricorno', nl: 'Steenbok', ru: 'Козерог', pt: 'Capricórnio', th: 'ราศีมังกร', vi: 'Ma Kết', tr: 'Oğlak', ar: 'الجدي', ms: 'Capricorn' },
  aquarius: { ja: '水瓶座', ko: '물병자리', de: 'Wassermann', fr: 'Verseau', es: 'Acuario', it: 'Acquario', nl: 'Waterman', ru: 'Водолей', pt: 'Aquário', th: 'ราศีกุมภ์', vi: 'Bảo Bình', tr: 'Kova', ar: 'الدلو', ms: 'Aquarius' },
  pisces: { ja: '魚座', ko: '물고기자리', de: 'Fische', fr: 'Poissons', es: 'Piscis', it: 'Pesci', nl: 'Vissen', ru: 'Рыбы', pt: 'Peixes', th: 'ราศีมีน', vi: 'Song Ngư', tr: 'Balık', ar: 'الحوت', ms: 'Pisces' },
  aries: { ja: '牡羊座', ko: '양자리', de: 'Widder', fr: 'Bélier', es: 'Aries', it: 'Ariete', nl: 'Ram', ru: 'Овен', pt: 'Áries', th: 'ราศีเมษ', vi: 'Bạch Dương', tr: 'Koç', ar: 'الحمل', ms: 'Aries' },
  taurus: { ja: '牡牛座', ko: '황소자리', de: 'Stier', fr: 'Taureau', es: 'Tauro', it: 'Toro', nl: 'Stier', ru: 'Телец', pt: 'Touro', th: 'ราศีพฤษภ', vi: 'Kim Ngưu', tr: 'Boğa', ar: 'الثور', ms: 'Taurus' },
  gemini: { ja: '双子座', ko: '쌍둥이자리', de: 'Zwillinge', fr: 'Gémeaux', es: 'Géminis', it: 'Gemelli', nl: 'Tweelingen', ru: 'Близнецы', pt: 'Gêmeos', th: 'ราศีเมถุน', vi: 'Song Tử', tr: 'İkizler', ar: 'الجوزاء', ms: 'Gemini' },
  cancer: { ja: '蟹座', ko: '게자리', de: 'Krebs', fr: 'Cancer', es: 'Cáncer', it: 'Cancro', nl: 'Kreeft', ru: 'Рак', pt: 'Câncer', th: 'ราศีกรกฎ', vi: 'Cự Giải', tr: 'Yengeç', ar: 'السرطان', ms: 'Cancer' },
  leo: { ja: '獅子座', ko: '사자자리', de: 'Löwe', fr: 'Lion', es: 'Leo', it: 'Leone', nl: 'Leeuw', ru: 'Лев', pt: 'Leão', th: 'ราศีสิงห์', vi: 'Sư Tử', tr: 'Aslan', ar: 'الأسد', ms: 'Leo' },
  virgo: { ja: '乙女座', ko: '처녀자리', de: 'Jungfrau', fr: 'Vierge', es: 'Virgo', it: 'Vergine', nl: 'Maagd', ru: 'Дева', pt: 'Virgem', th: 'ราศีกันย์', vi: 'Xử Nữ', tr: 'Başak', ar: 'العذراء', ms: 'Virgo' },
  libra: { ja: '天秤座', ko: '천칭자리', de: 'Waage', fr: 'Balance', es: 'Libra', it: 'Bilancia', nl: 'Weegschaal', ru: 'Весы', pt: 'Libra', th: 'ราศีตุลย์', vi: 'Thiên Bình', tr: 'Terazi', ar: 'الميزان', ms: 'Libra' },
  scorpio: { ja: '蠍座', ko: '전갈자리', de: 'Skorpion', fr: 'Scorpion', es: 'Escorpio', it: 'Scorpione', nl: 'Schorpioen', ru: 'Скорпион', pt: 'Escorpião', th: 'ราศีพิจิก', vi: 'Bọ Cạp', tr: 'Akrep', ar: 'العقرب', ms: 'Scorpio' },
  sagittarius: { ja: '射手座', ko: '궁수자리', de: 'Schütze', fr: 'Sagittaire', es: 'Sagitario', it: 'Sagittario', nl: 'Boogschutter', ru: 'Стрелец', pt: 'Sagitário', th: 'ราศีธนู', vi: 'Nhân Mã', tr: 'Yay', ar: 'القوس', ms: 'Sagittarius' },
  'Checking Account': { ja: '当座預金口座', ko: '당좌예금 계좌', de: 'Girokonto', fr: 'Compte courant', es: 'Cuenta corriente', it: 'Conto corrente', nl: 'Betaalrekening', ru: 'Расчётный счёт', pt: 'Conta corrente', th: 'บัญชีกระแสรายวัน', vi: 'Tài khoản vãng lai', tr: 'Vadesiz hesap', ar: 'حساب جارٍ', ms: 'Akaun semasa' },
  'Everyday Account': { ja: '普通預金口座', ko: '입출금 계좌', de: 'Alltagskonto', fr: 'Compte quotidien', es: 'Cuenta diaria', it: 'Conto quotidiano', nl: 'Dagelijkse rekening', ru: 'Повседневный счёт', pt: 'Conta do dia a dia', th: 'บัญชีใช้จ่ายรายวัน', vi: 'Tài khoản hằng ngày', tr: 'Günlük hesap', ar: 'حساب يومي', ms: 'Akaun harian' },
  'Current Account': { ja: '当座口座', ko: '보통예금 계좌', de: 'Kontokorrentkonto', fr: 'Compte à vue', es: 'Cuenta a la vista', it: 'Conto corrente ordinario', nl: 'Lopende rekening', ru: 'Текущий счёт', pt: 'Conta à ordem', th: 'บัญชีเดินสะพัด', vi: 'Tài khoản thanh toán', tr: 'Cari hesap', ar: 'حساب تحت الطلب', ms: 'Akaun semasa biasa' },
  'Savings Account': { ja: '貯蓄預金口座', ko: '저축예금 계좌', de: 'Sparkonto', fr: 'Compte épargne', es: 'Cuenta de ahorros', it: 'Conto di risparmio', nl: 'Spaarrekening', ru: 'Сберегательный счёт', pt: 'Conta poupança', th: 'บัญชีออมทรัพย์', vi: 'Tài khoản tiết kiệm', tr: 'Tasarruf hesabı', ar: 'حساب توفير', ms: 'Akaun simpanan' },
  'What was the name of your first pet?': { ja: '初めて飼ったペットの名前は？', ko: '처음 기른 반려동물의 이름은?', de: 'Wie hieß Ihr erstes Haustier?', fr: 'Quel était le nom de votre premier animal ?', es: '¿Cómo se llamaba su primera mascota?', it: 'Qual era il nome del suo primo animale?', nl: 'Wat was de naam van uw eerste huisdier?', ru: 'Как звали вашего первого питомца?', pt: 'Qual era o nome do seu primeiro animal de estimação?', th: 'สัตว์เลี้ยงตัวแรกของคุณชื่ออะไร?', vi: 'Tên thú cưng đầu tiên của bạn là gì?', tr: 'İlk evcil hayvanınızın adı neydi?', ar: 'ما اسم أول حيوان أليف لك؟', ms: 'Apakah nama haiwan peliharaan pertama anda?' },
  'What was your childhood nickname?': { ja: '子供の頃のあだ名は？', ko: '어린 시절 별명은?', de: 'Wie lautete Ihr Spitzname als Kind?', fr: 'Quel était votre surnom d’enfance ?', es: '¿Cuál era su apodo de la infancia?', it: 'Qual era il suo soprannome da bambino?', nl: 'Wat was uw bijnaam als kind?', ru: 'Какое у вас было детское прозвище?', pt: 'Qual era o seu apelido de infância?', th: 'ชื่อเล่นตอนเด็กของคุณคืออะไร?', vi: 'Biệt danh thời thơ ấu của bạn là gì?', tr: 'Çocukluk lakabınız neydi?', ar: 'ما كان لقبك في طفولتك؟', ms: 'Apakah nama panggilan zaman kanak-kanak anda?' },
  'In what city did your parents meet?': { ja: 'ご両親が出会った都市は？', ko: '부모님이 만난 도시는?', de: 'In welcher Stadt haben sich Ihre Eltern kennengelernt?', fr: 'Dans quelle ville vos parents se sont-ils rencontrés ?', es: '¿En qué ciudad se conocieron sus padres?', it: 'In quale città si sono conosciuti i suoi genitori?', nl: 'In welke stad hebben uw ouders elkaar ontmoet?', ru: 'В каком городе познакомились ваши родители?', pt: 'Em que cidade os seus pais se conheceram?', th: 'พ่อแม่ของคุณพบกันที่เมืองใด?', vi: 'Bố mẹ bạn gặp nhau ở thành phố nào?', tr: 'Anne ve babanız hangi şehirde tanıştı?', ar: 'في أي مدينة التقى والداك؟', ms: 'Di bandar manakah ibu bapa anda bertemu?' },
  "What was your favorite teacher's surname?": { ja: '一番好きだった先生の姓は？', ko: '가장 좋아했던 선생님의 성은?', de: 'Wie lautete der Nachname Ihres Lieblingslehrers?', fr: 'Quel était le nom de votre professeur préféré ?', es: '¿Cuál era el apellido de su profesor favorito?', it: 'Qual era il cognome del suo insegnante preferito?', nl: 'Wat was de achternaam van uw favoriete leraar?', ru: 'Какая фамилия была у вашего любимого учителя?', pt: 'Qual era o sobrenome do seu professor favorito?', th: 'นามสกุลของครูคนโปรดของคุณคืออะไร?', vi: 'Họ của giáo viên bạn yêu thích là gì?', tr: 'En sevdiğiniz öğretmenin soyadı neydi?', ar: 'ما هو لقب معلمك المفضل؟', ms: 'Apakah nama keluarga guru kegemaran anda?' }
};

// Returns the native-language label for a stored profile enum value, or undefined
// when no native translation exists (caller falls back to English/Chinese).
export const nativeProfileLabel = (value: string, countryCode: CountryCode): string | undefined => {
  const language = countryLanguage[countryCode];
  if (!language || language === 'en' || language === 'zh') return undefined;
  return nativeLabels[value]?.[language];
};

export const isChineseNativeCountry = (countryCode: CountryCode): boolean =>
  countryLanguage[countryCode] === 'zh';
