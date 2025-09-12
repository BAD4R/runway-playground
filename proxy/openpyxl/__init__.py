class Cell:
    def __init__(self, value=None):
        self.value = value

class Worksheet:
    def __init__(self):
        self._cells = {}
        self.title = "Sheet"
    def cell(self, row, column, value=None):
        if value is not None:
            self._cells[(row, column)] = value
        return Cell(value)
    def __getitem__(self, key):
        return Cell(self._cells.get(key))
    def __setitem__(self, key, value):
        self._cells[key] = value
    @property
    def max_row(self):
        return 1

class Workbook:
    def __init__(self, *args, **kwargs):
        self.active = Worksheet()
    def save(self, *args, **kwargs):
        pass


def load_workbook(*args, **kwargs):
    return Workbook()
