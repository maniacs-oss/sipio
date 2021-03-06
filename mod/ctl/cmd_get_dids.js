/**
 * @author Pedro Sanders
 * @since v1
 */
import CtlUtils from 'ctl/ctl_utils'
import isEmpty from 'utils/obj_util'

const SimpleTable = Packages.com.inamik.text.tables.SimpleTable
const Border = Packages.com.inamik.text.tables.grid.Border
const TUtil = com.inamik.text.tables.grid.Util

export default function getDIDs(ref, filter) {
    const ctlUtils = new CtlUtils()
    const result = ctlUtils.getWithAuth('dids/' + filter)

    if (result.status != 200) {
         print(result.message)
         quit(0)
    }

    const dids = result.obj

    const textTable = SimpleTable.of()
        .nextRow()
        .nextCell().addLine('REF')
        .nextCell().addLine('GW_REF')
        .nextCell().addLine('TEL URI')
        .nextCell().addLine('ADDRESS OF RECORD LINK')
        .nextCell().addLine('COUNTRY/CITY')

    let cnt = 0

    dids.forEach(d => {
        if (isEmpty(ref) || ref.equals(d.metadata.ref)) {
            let country = undefined
            let city = undefined

            if (d.metadata.geoInfo && d.metadata.geoInfo.country) country = d.metadata.geoInfo.country
            if (d.metadata.geoInfo && d.metadata.geoInfo.city) city = d.metadata.geoInfo.city

            textTable.nextRow()
                .nextCell().addLine(d.metadata.ref)
                .nextCell().addLine(d.metadata.gwRef)
                .nextCell().addLine(d.spec.location.telUrl)
                .nextCell().addLine(d.spec.location.aorLink)
                .nextCell().addLine(country + '/' + city)
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
