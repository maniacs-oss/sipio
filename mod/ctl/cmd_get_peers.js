/**
 * @author Pedro Sanders
 * @since v1
 */
import CtlUtils from 'ctl/ctl_utils'
import isEmpty from 'utils/obj_util'

const SimpleTable = Packages.com.inamik.text.tables.SimpleTable
const Border = Packages.com.inamik.text.tables.grid.Border
const TUtil = com.inamik.text.tables.grid.Util

export default function getPeers(ref, filter) {
    const ctlUtils = new CtlUtils()
    const result = ctlUtils.getWithAuth('peers/' + filter)

    if (result.status != 200) {
         print(result.message)
         quit(0)
    }

    const peers = result.obj

    const textTable = SimpleTable.of()
        .nextRow()
        .nextCell().addLine('REF')
        .nextCell().addLine('NAME')
        .nextCell().addLine('DEVICE NAME')

    let cnt = 0

    peers.forEach(p => {
        if (isEmpty(ref) || ref.equals(p.spec.credentials.username)) {
            let deviceName = '--'

            if (p.spec.device) deviceName = p.spec.device

            textTable.nextRow()
                .nextCell().addLine(p.spec.credentials.username)
                .nextCell().addLine(p.metadata.name)
                .nextCell().addLine(deviceName)
            cnt++
        }
    })

    if (cnt > 0) {
        let grid = textTable.toGrid()
        grid = Border.DOUBLE_LINE.apply(grid)
        TUtil.print(grid)
    } else {
        print("Resource/s not found.")
    }
}