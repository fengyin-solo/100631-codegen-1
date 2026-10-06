import type { CabinClass, SpdStatus } from './types'

/**
 * 上线前检测队记录纸上的老数据，按业务发生日（防雷检测日期）整批补录。
 * 这里刻意覆盖：强电/弱电分档、超上限、SPD异常、缺项、同点重复报送两版。
 * 缺项保持 null 并在 source 注明纸面出处，不臆造。
 */
export interface LegacyPaperRow {
  pointCode: string
  stake: string
  cabin: string
  cabinClass: CabinClass
  resistance: number | null
  overRange: boolean
  inspectDate: string
  spdCode: string
  spdStatus: SpdStatus
  deviceCode: string
  owner: string
  source: string
  note: string
}

export const LEGACY_PAPER: LegacyPaperRow[] = [
  {
    pointCode: 'LGT-K1+200',
    stake: 'K1+200',
    cabin: '电力舱A',
    cabinClass: '强电',
    resistance: 2.8,
    overRange: false,
    inspectDate: '2025-03-18',
    spdCode: 'SPD-K1200',
    spdStatus: '正常',
    deviceCode: 'DEVI-LGT-01',
    owner: '王强',
    source: '检测队2025年3月记录纸第12页',
    note: '年度检测，合格',
  },
  {
    pointCode: 'LGT-K1+500',
    stake: 'K1+500',
    cabin: '综合舱B',
    cabinClass: '弱电',
    resistance: 8.6,
    overRange: false,
    inspectDate: '2025-03-18',
    spdCode: 'SPD-K1500',
    spdStatus: '正常',
    deviceCode: 'DEVI-LGT-02',
    owner: '王强',
    source: '检测队2025年3月记录纸第12页',
    note: '弱电舱，10Ω档',
  },
  {
    pointCode: 'LGT-K1+800',
    stake: 'K1+800',
    cabin: '电力舱A',
    cabinClass: '强电',
    resistance: 6.5,
    overRange: false,
    inspectDate: '2025-03-19',
    spdCode: 'SPD-K1800',
    spdStatus: '劣化',
    deviceCode: 'DEVI-LGT-03',
    owner: '李敏',
    source: '检测队2025年3月记录纸第15页',
    note: '电阻超标且SPD压敏窗变红',
  },
  {
    pointCode: 'LGT-K2+100',
    stake: 'K2+100',
    cabin: '综合舱B',
    cabinClass: '弱电',
    resistance: 200,
    overRange: true,
    inspectDate: '2025-06-07',
    spdCode: 'SPD-K2100',
    spdStatus: '失效',
    deviceCode: 'DEVI-LGT-04',
    owner: '李敏',
    source: '检测队2025年6月记录纸第03页（表计显示超量程，记为>200Ω）',
    note: '引下线疑似断裂，读数超量程',
  },
  {
    pointCode: 'LGT-K2+400',
    stake: 'K2+400',
    cabin: '综合舱C',
    cabinClass: '弱电',
    resistance: null,
    overRange: false,
    inspectDate: '2025-06-07',
    spdCode: 'SPD-K2400',
    spdStatus: '正常',
    deviceCode: 'DEVI-LGT-05',
    owner: '赵磊',
    source: '检测队2025年6月记录纸第03页，电阻栏空白未填',
    note: '记录纸漏填接地电阻，缺项',
  },
  {
    pointCode: 'LGT-K2+700',
    stake: 'K2+700',
    cabin: '电力舱A',
    cabinClass: '强电',
    resistance: 3.6,
    overRange: false,
    inspectDate: '2025-09-10',
    spdCode: 'SPD-K2700',
    spdStatus: '正常',
    deviceCode: 'DEVI-LGT-06',
    owner: '赵磊',
    source: '检测队2025年9月记录纸第21页',
    note: '第一次报送（同日稍后有复测新版，补录时应以后版覆盖）',
  },
  {
    pointCode: 'LGT-K2+700',
    stake: 'K2+700',
    cabin: '电力舱A',
    cabinClass: '强电',
    resistance: 5.2,
    overRange: false,
    inspectDate: '2025-09-10',
    spdCode: 'SPD-K2700',
    spdStatus: '劣化',
    deviceCode: 'DEVI-LGT-06',
    owner: '赵磊',
    source: '检测队2025年9月记录纸第22页（同点第二次报送，更正读数）',
    note: '同点重复报送，只认这一版',
  },
  {
    pointCode: 'LGT-K3+000',
    stake: 'K3+000',
    cabin: '综合舱B',
    cabinClass: '弱电',
    resistance: 11.4,
    overRange: false,
    inspectDate: '2025-09-11',
    spdCode: 'SPD-K3000',
    spdStatus: '未装',
    deviceCode: 'DEVI-LGT-07',
    owner: '陈静',
    source: '检测队2025年9月记录纸第24页',
    note: '弱电舱超10Ω，SPD未安装',
  },
]
